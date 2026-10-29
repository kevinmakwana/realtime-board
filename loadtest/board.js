// Load test for the board server: k6 speaking Socket.IO (Engine.IO v4) over a plain WebSocket.
//
//   npm run loadtest                       # against http://localhost:8088 (the compose `scale` profile)
//   BASE_URL=https://board.example.com VUS=100 BOARDS=10 DURATION=120 k6 run loadtest/board.js
//
// Every virtual user is one person on one board. Users are spread over BOARDS boards, and nginx spreads their
// sockets over the server instances by the per-socket `cid`, so most boards have people on both instances.
// Each user creates cards, moves and comments on its own cards, and wiggles a cursor. What is measured:
//   - ack_ms        time from sending a command to its acknowledgement
//   - fanout_ms     time from a card being created until a socket on the board (the creator included) receives the `card.created` event,
//                   tagged cross_instance=true when the creator was on a different server instance
//   - events_missing / events_duplicate   holes or repeats in the `seq` numbers a socket received
// and the run fails (non-zero exit) on any lost, repeated or rejected command, or on slow percentiles.
//
// Scenarios (all optional, combine freely; see docs/load-testing.md):
//   STORM_AT=20       at 20 s every user drops its connection on purpose and comes back within STORM_SPREAD seconds
//                     (a reconnect storm). Measures resync_ms and join_bytes, and checks nothing was lost.
//   STORM_COLD=1      with STORM_AT: users come back as fresh page loads (no last seq), so each pulls a full snapshot.
//   RECONNECT=1       an unplanned disconnect (for example `docker compose restart server-1` during the run) is an
//                     outage to recover from instead of a failure: users reconnect, catch up and keep going.
//   SEED_CARDS=30     each user first creates 30 cards (SEED_PER_SEC per second each), so BOARDS=1 VUS=100 gives one
//                     board with ~3000 cards. Keep VUS x (SEED_PER_SEC + OPS_PER_SEC) near what the server can take.
//
// Sign-in is rate limited per IP (AUTH_RATE_LIMIT_PER_MIN, default 20), so start the stack with a higher limit:
//   AUTH_RATE_LIMIT_PER_MIN=10000 docker compose --profile scale up -d --build --wait

import http from 'k6/http';
import ws from 'k6/ws';
import { check, fail, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:8088').replace(/\/$/, '');
const VUS = Number(__ENV.VUS || 40);
const BOARDS = Math.min(Number(__ENV.BOARDS || 4), VUS);
const DURATION_S = Number(__ENV.DURATION || 60); // how long each user stays connected and active
const RAMP_S = Number(__ENV.RAMP || 10); // users join spread over this many seconds
const OPS_PER_SEC = Number(__ENV.OPS_PER_SEC || 2); // commands per user (the server allows 20/s per socket)
const CURSORS_PER_SEC = Number(__ENV.CURSORS_PER_SEC || 5);
const DRAIN_S = 3; // stop sending this long before disconnecting so the last events arrive
const STORM_AT = Number(__ENV.STORM_AT || 0); // seconds into the run; 0 = no storm
const STORM_SPREAD_S = Number(__ENV.STORM_SPREAD || 2);
const STORM_COLD = ['1', 'true'].includes(String(__ENV.STORM_COLD || '')); // come back like a fresh page load: no last seq, full snapshot
const RECONNECT = ['1', 'true'].includes(String(__ENV.RECONNECT || '')) || STORM_AT > 0;
const SEED_CARDS = Number(__ENV.SEED_CARDS || 0); // cards each user creates before the normal mix
const SEED_PER_SEC = Number(__ENV.SEED_PER_SEC || 5); // how fast (the server allows 20 commands/s per socket)
const RECONNECT_GIVE_UP_S = 30; // a user that cannot get back in this long after its drop has failed
const STEADY = !RECONNECT; // without reconnecting, a closed socket is a failure and a repeated seq is a bug

const ackMs = new Trend('ack_ms', true);
const fanoutMs = new Trend('fanout_ms', true);
const crossInstance = new Counter('fanout_cross_instance'); // events that travelled between server instances
const opsOk = new Counter('ops_ok');
const opsFailed = new Counter('ops_failed');
const connectFailures = new Counter('connect_failures');
const eventsReceived = new Counter('events_received');
const eventsMissing = new Counter('events_missing');
const eventsDuplicate = new Counter('events_duplicate');
const eventsOutOfOrder = new Counter('events_out_of_order');
const historyGaps = new Counter('history_gaps');
const resyncMs = new Trend('resync_ms', true); // new connection until its join was answered
const outageMs = new Trend('outage_ms', true); // an unplanned drop until the user was back
const joinBytes = new Trend('join_bytes'); // size of the join answer (a snapshot or a replay)
const joinsSnapshot = new Counter('joins_snapshot');
const joinsReplay = new Counter('joins_replay');
const reconnectFailed = new Counter('reconnect_failed');
const scriptErrors = new Counter('script_errors'); // an exception in this script: the run proves nothing
const opsInDoubt = new Counter('ops_in_doubt'); // sent, then the connection broke before the answer

export const options = {
  scenarios: {
    boards: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: `${RAMP_S + DURATION_S + 60}s`,
    },
  },
  thresholds: {
    // Correctness: nothing lost, repeated or refused. These must be exactly zero.
    connect_failures: ['count==0'],
    script_errors: ['count==0'],
    ops_failed: ['count==0'],
    events_missing: ['count==0'],
    // A reconnect legitimately delivers an event twice (live broadcast and replay); clients drop repeats by seq.
    events_duplicate: STEADY ? ['count==0'] : ['count>=0'],
    history_gaps: ['count==0'],
    // The run must actually have exercised both instances.
    events_received: ['count>0'],
    fanout_cross_instance: ['count>0'],
    'fanout_ms{cross_instance:true}': [`p(95)<${__ENV.FANOUT_P95_MS || 1000}`],
    'fanout_ms{cross_instance:false}': [`p(95)<${__ENV.FANOUT_P95_MS || 1000}`],
    ack_ms: [`p(95)<${__ENV.ACK_P95_MS || 500}`],
    ...(RECONNECT && {
      reconnect_failed: ['count==0'],
      resync_ms: [`p(95)<${__ENV.RESYNC_P95_MS || 5000}`],
    }),
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const json = (token) => ({ headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });

function login(i) {
  const res = http.post(
    `${BASE_URL}/api/auth/dev-login`,
    JSON.stringify({ email: `load-${i}@example.test`, name: `Load ${i}` }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (res.status === 429) fail('sign-in was rate limited: start the server with AUTH_RATE_LIMIT_PER_MIN=10000');
  if (res.status !== 200) fail(`dev-login answered ${res.status}: ${res.body} (is AUTH_DEV_LOGIN on?)`);
  return res.json();
}

/** Creates the users, the boards and the memberships; every user gets a seat on exactly one board. */
export function setup() {
  const users = [];
  for (let i = 0; i < VUS; i++) users.push(login(i));

  const boards = [];
  for (let b = 0; b < BOARDS; b++) {
    const owner = users[b]; // user b owns board b and sits on it
    const created = http.post(`${BASE_URL}/api/boards`, JSON.stringify({ name: `Load test ${b}` }), json(owner.token));
    if (created.status !== 201) fail(`creating a board answered ${created.status}: ${created.body}`);
    const board = created.json(); // the new board's snapshot
    boards.push({ id: board.board.id, columnIds: board.columns.map((c) => c.id), ownerToken: owner.token });
  }

  const seats = users.map((u, i) => {
    const board = boards[i % BOARDS];
    if (i >= BOARDS) {
      const res = http.post(
        `${BASE_URL}/api/boards/${board.id}/members`,
        JSON.stringify({ email: `load-${i}@example.test`, role: 'editor' }),
        json(board.ownerToken),
      );
      if (res.status >= 300) fail(`adding a member answered ${res.status}: ${res.body}`);
    }
    return { token: u.token, boardId: board.id, columnIds: board.columnIds };
  });
  return { seats, boardIds: boards.map((b) => b.id), tokens: boards.map((b) => b.ownerToken) };
}

const BASE62 = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'; // no 0: a key may not end in it

/** A random fractional-indexing key (`a0` + a fraction). Collisions are resolved by the server. */
function randomKey() {
  let k = 'a0';
  for (let i = 0; i < 8; i++) k += BASE62[Math.floor(Math.random() * BASE62.length)];
  return k;
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Socket.IO packet: `4` (message) + type + [ack id] + JSON. Returns null for anything we do not need. */
function parse(data) {
  if (typeof data !== 'string' || data[0] !== '4') return null;
  const type = data[1];
  let i = 2;
  let id = '';
  while (data[i] >= '0' && data[i] <= '9') id += data[i++];
  const body = data.slice(i);
  return { type, id: id === '' ? null : Number(id), body: body ? JSON.parse(body) : null };
}

export default function (data) {
  const seat = data.seats[__VU - 1];
  sleep((Math.random() * RAMP_S * 1000) / 1000); // spread the joins

  const endAt = Date.now() + DURATION_S * 1000;
  // What this user has learned so far; it outlives any single connection.
  const run = {
    seen: new Set(),
    firstSeq: null, // seq of the first join: nothing before it is ours to account for
    maxSeq: 0,
    floor: 0, // everything up to here was delivered as a snapshot
    instance: '',
    myCards: [], // { id, version, moving }
    seedLeft: SEED_CARDS,
    stormPending: STORM_AT > 0,
    cold: false, // the next join sends no last seq
    finished: false,
    droppedAt: 0, // when an unplanned drop was noticed
    gaveUp: false,
  };

  for (let attempt = 0; ; attempt++) {
    let outcome;
    try {
      outcome = connectOnce(seat, run, endAt, attempt);
    } catch (e) {
      scriptErrors.add(1);
      console.error(`script error: ${e}`);
      return;
    }
    if (outcome === 'done') break;
    if (outcome === 'dropped') {
      if (!RECONNECT) {
        connectFailures.add(1);
        break;
      }
      if (!run.droppedAt) run.droppedAt = Date.now();
      if (Date.now() - run.droppedAt > RECONNECT_GIVE_UP_S * 1000) {
        reconnectFailed.add(1);
        break;
      }
      sleep(0.3 + Math.random() * 1.2); // back off like a real client would
    } else if (outcome === 'storm') {
      sleep(Math.random() * STORM_SPREAD_S);
    }
    if (Date.now() > endAt + RECONNECT_GIVE_UP_S * 1000) {
      reconnectFailed.add(1);
      break;
    }
  }
  if (run.firstSeq !== null) {
    // Every sequence number between where we first joined and the newest one must have arrived (or been covered by a snapshot).
    for (let q = run.firstSeq + 1; q < run.maxSeq; q++) if (q > run.floor && !run.seen.has(q)) eventsMissing.add(1);
  }
}

/** One connection's life. Returns 'done' (planned end), 'storm' (we hung up on purpose) or 'dropped' (it broke). */
function connectOnce(seat, run, endAt, attempt) {
  const wsUrl = `${BASE_URL.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket&cid=${uuid()}`;
  const startedAt = Date.now();
  let ackId = 0;
  let sending = false;
  let outcome = 'dropped';
  let joinSize = 0;
  const pending = new Map(); // ack id -> { command, sentAt, done }

  const res = ws.connect(wsUrl, {}, (socket) => {
    const emit = (name, payload, done) => {
      const id = ++ackId;
      pending.set(id, { command: name, sentAt: Date.now(), done });
      socket.send(`42${id}${JSON.stringify([name, payload])}`);
    };
    const fire = (name, payload) => socket.send(`42${JSON.stringify([name, payload])}`);

    const createCard = (title) => {
      const c = { id: uuid(), version: 1 };
      emit(
        'card:create',
        { id: c.id, boardId: seat.boardId, columnId: seat.columnIds[0], title, position: randomKey() },
        (ack) => {
          if (ack.ok) {
            c.version = ack.version;
            run.myCards.push(c);
          }
        },
      );
    };

    const tick = () => {
      if (!sending) return;
      const roll = Math.random();
      // Only touch a card whose last move has been acknowledged, or its version would be stale (our own conflict).
      const idle = run.myCards.filter((c) => !c.moving);
      const card = idle.length ? idle[Math.floor(Math.random() * idle.length)] : null;
      if (card && roll < 0.25) {
        const columnId = seat.columnIds[Math.floor(Math.random() * seat.columnIds.length)];
        card.moving = true;
        emit(
          'card:move',
          { id: card.id, boardId: seat.boardId, baseVersion: card.version, columnId, position: randomKey() },
          (ack) => {
            card.moving = false;
            if (ack.ok) card.version = ack.version;
          },
        );
      } else if (card && roll < 0.4) {
        emit('comment:add', { id: uuid(), boardId: seat.boardId, cardId: card.id, body: `Looks good (${Date.now()})` });
      } else {
        // The title carries who made it, where, and when, so any receiver can time the fan-out.
        createCard(`lt|${run.instance}|${Date.now()}`);
      }
    };

    const onEvent = (name, payload, replayed) => {
      if (name !== 'board:event') return;
      eventsReceived.add(1);
      const { seq } = payload;
      if (seq <= run.floor || seq <= (run.firstSeq ?? 0)) return; // already part of a snapshot we joined with
      if (run.seen.has(seq)) {
        if (!replayed) eventsDuplicate.add(1);
        return;
      }
      if (seq < run.maxSeq) eventsOutOfOrder.add(1); // legitimate across instances: clients re-sequence
      run.seen.add(seq);
      run.maxSeq = Math.max(run.maxSeq, seq);
      if (!replayed && payload.type === 'card.created' && payload.card.title.startsWith('lt|')) {
        const [, creatorInstance, sentAt] = payload.card.title.split('|');
        const cross = creatorInstance !== run.instance;
        if (cross) crossInstance.add(1);
        fanoutMs.add(Date.now() - Number(sentAt), { cross_instance: String(cross) });
      }
    };

    const onJoined = (ack, bytes) => {
      const rejoin = run.firstSeq !== null;
      run.instance = ack.instance;
      if (ack.mode === 'snapshot') {
        joinsSnapshot.add(1);
        run.floor = Math.max(run.floor, ack.snapshot.seq);
        run.maxSeq = Math.max(run.maxSeq, ack.snapshot.seq);
        if (!rejoin) run.firstSeq = ack.snapshot.seq;
      } else {
        joinsReplay.add(1);
        for (const e of ack.events) onEvent('board:event', e, true);
        run.maxSeq = Math.max(run.maxSeq, ack.seq);
      }
      if (rejoin) {
        joinBytes.add(bytes);
        resyncMs.add(Date.now() - startedAt, { mode: ack.mode });
        if (run.droppedAt) outageMs.add(Date.now() - run.droppedAt);
      } else {
        joinBytes.add(bytes);
      }
      run.droppedAt = 0;
      sending = true;

      const opsEvery = 1000 / OPS_PER_SEC;
      socket.setInterval(tick, opsEvery);
      if (run.seedLeft > 0) {
        socket.setInterval(() => {
          if (!sending || run.seedLeft <= 0) return;
          run.seedLeft--;
          createCard(`seed|${run.instance}|${Date.now()}`);
        }, 1000 / SEED_PER_SEC);
      }
      if (CURSORS_PER_SEC > 0) {
        socket.setInterval(
          () => sending && fire('presence:cursor', { boardId: seat.boardId, x: Math.random(), y: Math.random() }),
          1000 / CURSORS_PER_SEC,
        );
      }
      const left = endAt - Date.now();
      socket.setTimeout(() => (sending = false), Math.max(1, left - DRAIN_S * 1000));
      socket.setTimeout(
        () => {
          run.finished = true;
          outcome = 'done';
          socket.close();
        },
        Math.max(1, left),
      );
      if (run.stormPending) {
        const stormIn = STORM_AT * 1000 - (Date.now() - (endAt - DURATION_S * 1000));
        socket.setTimeout(
          () => {
            run.stormPending = false;
            run.cold = STORM_COLD;
            outcome = 'storm';
            sending = false;
            socket.close();
          },
          Math.max(1, stormIn),
        );
      }
    };

    socket.on('message', (raw) => {
      if (raw === '2') return socket.send('3'); // Engine.IO ping -> pong
      if (raw[0] === '0') return socket.send(`40${JSON.stringify({ token: seat.token })}`); // open -> connect
      const packet = parse(raw);
      if (!packet) return;
      if (packet.type === '0') {
        // Connected to the namespace: join the board (with where we got to, after a reconnect).
        const lastSeq = run.firstSeq !== null && !run.cold ? run.maxSeq : undefined;
        run.cold = false;
        emit('board:join', { boardId: seat.boardId, ...(lastSeq !== undefined && { lastSeq }) }, (ack) => {
          if (!ack.ok) {
            connectFailures.add(1);
            run.finished = true;
            outcome = 'done';
            return socket.close();
          }
          onJoined(ack, joinSize);
        });
      } else if (packet.type === '4') {
        connectFailures.add(1);
        run.finished = true;
        outcome = 'done';
        socket.close();
      } else if (packet.type === '2') {
        onEvent(packet.body[0], packet.body[1], false);
      } else if (packet.type === '3') {
        const waiting = pending.get(packet.id);
        if (!waiting) return;
        pending.delete(packet.id);
        const ack = packet.body[0];
        if (waiting.command !== 'board:join') {
          ackMs.add(Date.now() - waiting.sentAt, { command: waiting.command });
          if (ack.ok) opsOk.add(1);
          else {
            opsFailed.add(1, { code: ack.code });
            console.error(`${waiting.command} failed: ${ack.code} ${ack.message}`);
          }
        }
        if (waiting.command === 'board:join') joinSize = raw.length; // the answer's size on the wire
        waiting.done?.(ack);
      }
    });
    socket.on('close', () => {
      // A socket that ends before its planned end (dropped, kicked, proxy timeout) is a failed run unless we are
      // meant to recover from that; and a command that never got its answer is in doubt, or failed.
      if (pending.size > 0) {
        if (RECONNECT) {
          opsInDoubt.add(pending.size);
          // A move whose answer we never saw may or may not have happened: stop touching that card's version.
          run.myCards = run.myCards.filter((c) => !c.moving);
        } else opsFailed.add(pending.size);
      }
    });
    socket.on('error', (e) => {
      if (!RECONNECT) connectFailures.add(1);
      console.error(`socket error: ${e.error()}`);
    });
  });
  if (res && res.status !== 101) {
    if (!RECONNECT || attempt === 0) connectFailures.add(1);
  }
  check(res, { 'upgraded to a WebSocket': (r) => r && r.status === 101 });
  return outcome;
}

/** The database side: every board's log must be gapless, whatever the sockets saw. */
export function teardown(data) {
  for (let i = 0; i < data.boardIds.length; i++) {
    const token = data.tokens[i];
    let after = 0;
    for (;;) {
      const res = http.get(`${BASE_URL}/api/boards/${data.boardIds[i]}/events?after=${after}`, json(token));
      if (res.status !== 200) {
        historyGaps.add(1);
        break;
      }
      const { events } = res.json();
      if (events.length === 0) break;
      for (const e of events) {
        if (e.seq !== after + 1) historyGaps.add(1);
        after = e.seq;
      }
    }
  }
}
