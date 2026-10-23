// Load test for the board server: k6 speaking Socket.IO (Engine.IO v4) over a plain WebSocket.
//
//   npm run loadtest                       # against http://localhost:8088 (the compose `scale` profile)
//   BASE_URL=https://board.example.com VUS=100 BOARDS=10 DURATION=120 k6 run loadtest/board.js
//
// Every virtual user is one person on one board. Users are spread over BOARDS boards, and nginx spreads their
// sockets over the server instances by the per-socket `cid`, so most boards have people on both instances.
// Each user creates cards, moves and comments on its own cards, and wiggles a cursor. What is measured:
//   - ack_ms        time from sending a command to its acknowledgement
//   - fanout_ms     time from a card being created until another socket receives the `card.created` event,
//                   tagged cross_instance=true when the creator was on a different server instance
//   - events_missing / events_duplicate   holes or repeats in the `seq` numbers a socket received
// and the run fails (non-zero exit) on any lost, repeated or rejected command, or on slow percentiles.
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
    ops_failed: ['count==0'],
    events_missing: ['count==0'],
    events_duplicate: ['count==0'],
    history_gaps: ['count==0'],
    // The run must actually have exercised both instances.
    events_received: ['count>0'],
    fanout_cross_instance: ['count>0'],
    'fanout_ms{cross_instance:true}': [`p(95)<${__ENV.FANOUT_P95_MS || 1000}`],
    'fanout_ms{cross_instance:false}': [`p(95)<${__ENV.FANOUT_P95_MS || 1000}`],
    ack_ms: [`p(95)<${__ENV.ACK_P95_MS || 500}`],
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
  const wsUrl = `${BASE_URL.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket&cid=${uuid()}`;
  sleep((Math.random() * RAMP_S * 1000) / 1000); // spread the joins

  const seen = new Set();
  let joinSeq = 0;
  let maxSeq = 0;
  let instance = '';
  let ackId = 0;
  const pending = new Map(); // ack id -> { command, sentAt, done }
  const myCards = []; // { id, version, moving }
  let sending = false;

  const res = ws.connect(wsUrl, {}, (socket) => {
    const emit = (name, payload, done) => {
      const id = ++ackId;
      pending.set(id, { command: name, sentAt: Date.now(), done });
      socket.send(`42${id}${JSON.stringify([name, payload])}`);
    };
    const fire = (name, payload) => socket.send(`42${JSON.stringify([name, payload])}`);

    const tick = () => {
      if (!sending) return;
      const roll = Math.random();
      // Only touch a card whose last move has been acknowledged, or its version would be stale (our own conflict).
      const idle = myCards.filter((c) => !c.moving);
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
        const c = { id: uuid(), version: 1 };
        // The title carries who made it, where, and when, so any receiver can time the fan-out.
        const title = `lt|${instance}|${Date.now()}`;
        emit(
          'card:create',
          { id: c.id, boardId: seat.boardId, columnId: seat.columnIds[0], title, position: randomKey() },
          (ack) => {
            if (ack.ok) {
              c.version = ack.version;
              myCards.push(c);
            }
          },
        );
      }
    };

    const onEvent = (name, payload) => {
      if (name !== 'board:event') return;
      eventsReceived.add(1);
      const { seq } = payload;
      if (seq <= joinSeq) return; // already part of the snapshot we joined with
      if (seen.has(seq)) eventsDuplicate.add(1);
      else {
        if (seq < maxSeq) eventsOutOfOrder.add(1); // legitimate across instances: clients re-sequence
        seen.add(seq);
        maxSeq = Math.max(maxSeq, seq);
      }
      if (payload.type === 'card.created' && payload.card.title.startsWith('lt|')) {
        const [, creatorInstance, sentAt] = payload.card.title.split('|');
        const cross = creatorInstance !== instance;
        if (cross) crossInstance.add(1);
        fanoutMs.add(Date.now() - Number(sentAt), { cross_instance: String(cross) });
      }
    };

    socket.on('message', (raw) => {
      if (raw === '2') return socket.send('3'); // Engine.IO ping -> pong
      if (raw[0] === '0') return socket.send(`40${JSON.stringify({ token: seat.token })}`); // open -> connect
      const packet = parse(raw);
      if (!packet) return;
      if (packet.type === '0') {
        // Connected to the namespace: join the board.
        emit('board:join', { boardId: seat.boardId }, (ack) => {
          if (!ack.ok) {
            connectFailures.add(1);
            return socket.close();
          }
          instance = ack.instance;
          joinSeq = ack.snapshot.seq;
          maxSeq = joinSeq;
          sending = true;
          socket.setInterval(tick, 1000 / OPS_PER_SEC);
          if (CURSORS_PER_SEC > 0) {
            socket.setInterval(
              () => sending && fire('presence:cursor', { boardId: seat.boardId, x: Math.random(), y: Math.random() }),
              1000 / CURSORS_PER_SEC,
            );
          }
          socket.setTimeout(() => (sending = false), (DURATION_S - DRAIN_S) * 1000);
          socket.setTimeout(() => {
            // Every sequence number between where we joined and the newest one must have arrived.
            for (let s = joinSeq + 1; s < maxSeq; s++) if (!seen.has(s)) eventsMissing.add(1);
            socket.close();
          }, DURATION_S * 1000);
        });
      } else if (packet.type === '4') {
        connectFailures.add(1);
        socket.close();
      } else if (packet.type === '2') {
        onEvent(packet.body[0], packet.body[1]);
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
        waiting.done?.(ack);
      }
    });
    socket.on('error', (e) => {
      connectFailures.add(1);
      console.error(`socket error: ${e.error()}`);
    });
  });
  check(res, { 'upgraded to a WebSocket': (r) => r && r.status === 101 }) || connectFailures.add(1);
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
