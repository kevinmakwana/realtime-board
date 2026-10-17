import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyEvents, stateFromSnapshot, SeqBuffer } from '@board/shared';
import type { ServerInstance } from '../src/server.js';
import {
  addCard,
  collectEvents,
  createWorld,
  emit,
  join,
  startInstance,
  startPair,
  type TestWorld,
} from './helpers.js';

describe('reconnect catch-up', () => {
  const world: TestWorld = createWorld();
  let a: ServerInstance;
  let b: ServerInstance;

  beforeAll(async () => {
    [a, b] = await startPair('catchup-a', 'catchup-b', { REPLAY_MAX_EVENTS: 5 });
  });
  afterAll(async () => {
    await world.close();
    await Promise.all([a.close(), b.close()]);
  });

  it('replays exactly the missed events (even via a different instance) and converges on the same state', async () => {
    const ada = await world.newUser('Ada');
    const grace = await world.newUser('Grace');
    const snap = await world.newBoard(ada.id);

    const writer = await world.connect(a.port, ada.token);
    await join(writer, snap.board.id);

    // Grace joins on instance B, sees 2 cards, then loses her connection.
    let reader = await world.connect(b.port, grace.token);
    const first = await join(reader, snap.board.id);
    expect(first).toMatchObject({ ok: true, mode: 'snapshot' });
    const seen = collectEvents(reader);
    await addCard(writer, snap, 'one');
    await addCard(writer, snap, 'two');
    await expect.poll(() => seen.length, { timeout: 5000 }).toBe(2);
    const lastSeq = seen.at(-1)!.seq;
    reader.disconnect();

    // While she is away: 4 more events (a create, an edit, another create and a delete).
    const three = await addCard(writer, snap, 'three');
    await emit(writer, 'card:update', {
      id: three.id,
      boardId: snap.board.id,
      baseVersion: 1,
      title: 'three (edited)',
    });
    const four = await addCard(writer, snap, 'four');
    await emit(writer, 'card:delete', { id: four.id, boardId: snap.board.id, baseVersion: 1 });

    // She reconnects - to the OTHER instance - with only her last seen seq.
    reader = await world.connect(a.port, grace.token);
    const rejoin = await join(reader, snap.board.id, lastSeq);
    expect(rejoin).toMatchObject({ ok: true, mode: 'replay' });
    if (!rejoin.ok || rejoin.mode !== 'replay') throw new Error('expected replay');
    expect(rejoin.events.map((e) => e.type)).toEqual(['card.created', 'card.updated', 'card.created', 'card.deleted']);
    expect(rejoin.events.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
    expect(rejoin.seq).toBe(6);

    // Applying snapshot-at-lastSeq + replay equals the server's current state.
    const early = stateFromSnapshot({ ...snap, seq: 0 });
    const buffer = new SeqBuffer(0);
    const all = [...seen, ...rejoin.events];
    const caughtUp = applyEvents(early, buffer.offerMany(all).events);
    const truth = stateFromSnapshot((await world.service.getSnapshot(snap.board.id))!);
    expect(caughtUp.cards).toEqual(truth.cards);
    expect(caughtUp.seq).toBe(truth.seq);
  });

  it('falls back to a full snapshot when the client is too far behind', async () => {
    const ada = await world.newUser('Ada');
    const snap = await world.newBoard(ada.id);
    const s = await world.connect(a.port, ada.token);
    await join(s, snap.board.id);
    for (let i = 0; i < 8; i++) await addCard(s, snap, `card ${i}`);

    const late = await world.connect(b.port, ada.token);
    const ack = await join(late, snap.board.id, 1); // 7 behind, limit is 5
    expect(ack).toMatchObject({ ok: true, mode: 'snapshot' });
    if (ack.ok && ack.mode === 'snapshot') {
      expect(ack.snapshot.cards).toHaveLength(8);
      expect(ack.snapshot.seq).toBe(8);
    }
  });

  it('answers an up-to-date client with an empty replay, and a client from the future with a snapshot', async () => {
    const ada = await world.newUser('Ada');
    const snap = await world.newBoard(ada.id);
    const s = await world.connect(a.port, ada.token);
    await join(s, snap.board.id);
    await addCard(s, snap, 'x');
    const s2 = await world.connect(a.port, ada.token);
    expect(await join(s2, snap.board.id, 1)).toMatchObject({ ok: true, mode: 'replay', events: [], seq: 1 });
    const s3 = await world.connect(a.port, ada.token);
    expect(await join(s3, snap.board.id, 99)).toMatchObject({ ok: true, mode: 'snapshot' });
  });
});
