import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyBetween } from '@board/shared';
import { Retention } from '../src/retention.js';
import type { ServerInstance } from '../src/server.js';
import { createWorld, emit, join, startInstance, type TestWorld } from './helpers.js';

describe('event log retention', () => {
  const world: TestWorld = createWorld();
  let server: ServerInstance;
  beforeAll(async () => {
    server = await startInstance('retention-a');
  });
  afterAll(async () => {
    await world.close();
    await server.close();
  });

  const retention = (over: Partial<ConstructorParameters<typeof Retention>[1]> = {}) =>
    new Retention(world.pool, { days: 30, minEvents: 5, batchSize: 1000, ...over });

  /** A board with `n` events in its log (the first `aged` of them dated 200 days ago), and its owner. */
  async function boardWithEvents(n: number, aged: number) {
    const owner = await world.newUser();
    const snap = await world.newBoard(owner.id);
    const base = await world.service.latestSeq(snap.board.id);
    let position: string | null = null;
    for (let i = 0; i < n; i++) {
      position = keyBetween(position, null);
      await world.service.createCard(owner.id, {
        id: randomUUID(),
        boardId: snap.board.id,
        columnId: snap.columns[0]!.id,
        title: `Card ${i}`,
        position,
      });
    }
    await world.pool.query(
      "UPDATE board_events SET created_at = now() - interval '200 days' WHERE board_id = $1 AND seq <= $2",
      [snap.board.id, (base ?? 0) + aged],
    );
    return { owner, boardId: snap.board.id, snap, base: base ?? 0 };
  }
  const seqs = async (boardId: string) =>
    (await world.pool.query('SELECT seq FROM board_events WHERE board_id = $1 ORDER BY seq', [boardId])).rows.map(
      (r) => r.seq as number,
    );

  it('deletes old events but always keeps the newest few, however old', async () => {
    const { boardId } = await boardWithEvents(20, 20);
    const last = (await world.service.latestSeq(boardId))!;
    const result = await retention().runOnce();
    expect(result.pruned).toBeGreaterThanOrEqual(15);
    expect(await seqs(boardId)).toEqual([last - 4, last - 3, last - 2, last - 1, last]);
  });

  it('keeps recent events even when there are many', async () => {
    const { boardId, base } = await boardWithEvents(20, 10);
    await retention().runOnce();
    const left = await seqs(boardId);
    expect(left[0]).toBe(base + 11); // the ten aged ones went; the ten recent ones stayed
    expect(left.at(-1)).toBe(base + 20);
  });

  it('keeps old events that are among the newest few', async () => {
    const { boardId } = await boardWithEvents(4, 4);
    const before = await seqs(boardId);
    await retention({ minEvents: 100 }).runOnce();
    expect(await seqs(boardId)).toEqual(before);
  });

  it('works through a large backlog in batches and says how much it removed', async () => {
    const { boardId } = await boardWithEvents(30, 30);
    const result = await retention({ batchSize: 4 }).runOnce();
    expect(result.pruned).toBeGreaterThanOrEqual(25);
    expect((await seqs(boardId)).length).toBe(5);
  });

  it('does nothing when retention is switched off', async () => {
    const { boardId } = await boardWithEvents(10, 10);
    const before = await seqs(boardId);
    expect(await retention({ days: 0 }).runOnce()).toEqual({ pruned: 0, skipped: false });
    expect(await seqs(boardId)).toEqual(before);
  });

  it('lets only one instance prune at a time', async () => {
    await boardWithEvents(10, 10);
    const holder = await world.pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [Retention.LOCK_KEY]);
      expect(await retention().runOnce()).toEqual({ pruned: 0, skipped: true });
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [Retention.LOCK_KEY]);
      holder.release();
    }
    expect((await retention().runOnce()).skipped).toBe(false);
  });

  describe('what pruning must not break', () => {
    it('leaves the board itself alone and keeps numbering events without gaps', async () => {
      const { owner, boardId, snap } = await boardWithEvents(12, 12);
      const cardsBefore = (await world.service.getSnapshot(boardId))!.cards.length;
      const last = (await world.service.latestSeq(boardId))!;
      await retention().runOnce();
      expect((await world.service.getSnapshot(boardId))!.cards).toHaveLength(cardsBefore);

      const socket = await world.connect(server.port, owner.token);
      await join(socket, boardId);
      const ack = await emit(socket, 'card:create', {
        id: randomUUID(),
        boardId,
        columnId: snap.columns[0]!.id,
        title: 'After pruning',
        position: keyBetween(null, null),
      });
      expect(ack.ok).toBe(true);
      expect(ack.seq).toBe(last + 1);
    });

    it('sends a snapshot instead of a replay to a client whose position was pruned, and a replay to one that is current', async () => {
      const { owner, boardId } = await boardWithEvents(12, 12);
      const last = (await world.service.latestSeq(boardId))!;
      await retention().runOnce();

      const stale = await world.connect(server.port, owner.token);
      const staleAck = await join(stale, boardId, last - 11);
      expect(staleAck.ok && staleAck.mode).toBe('snapshot');

      const current = await world.connect(server.port, owner.token);
      const currentAck = await join(current, boardId, last - 3);
      expect(currentAck.ok && currentAck.mode).toBe('replay');
    });

    it('never replays a log with a hole in it, even when the number of events happens to match', async () => {
      const { owner, boardId, base } = await boardWithEvents(10, 0);
      const head = (await world.service.latestSeq(boardId))!;
      // Events base+3 and base+4 were pruned, and two more were appended after the server read the head.
      await world.pool.query('DELETE FROM board_events WHERE board_id = $1 AND seq IN ($2, $3)', [
        boardId,
        base + 3,
        base + 4,
      ]);
      await world.pool.query(
        `INSERT INTO board_events (board_id, seq, type, payload, actor_id)
         SELECT e.board_id, $2::int + g.n, e.type, e.payload, e.actor_id
           FROM board_events e CROSS JOIN generate_series(1, 2) AS g(n)
          WHERE e.board_id = $1 AND e.seq = $3`,
        [boardId, head, base + 1],
      );
      const socket = await world.connect(server.port, owner.token);
      const ack = await join(socket, boardId, base + 2); // behind = 8, and 8 events exist after base+2 (5..12)
      expect(ack.ok && ack.mode).toBe('snapshot');
    });

    it('answers a catch-up request for pruned history with 410, and a retained range normally', async () => {
      const { owner, boardId } = await boardWithEvents(12, 12);
      const last = (await world.service.latestSeq(boardId))!;
      await retention().runOnce();
      const get = (after: number) =>
        fetch(`http://localhost:${server.port}/api/boards/${boardId}/events?after=${after}`, {
          headers: { authorization: `Bearer ${owner.token}` },
        });
      expect((await get(0)).status).toBe(410);
      expect(((await (await get(0)).json()) as { error: string }).error).toMatch(/snapshot/i);
      const ok = await get(last - 2);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { events: unknown[] }).events).toHaveLength(2);
      expect(((await (await get(last)).json()) as { events: unknown[] }).events).toEqual([]);
    });

    it('still builds the activity feed from what is left', async () => {
      const { owner, boardId } = await boardWithEvents(12, 12);
      await retention().runOnce();
      const res = await fetch(`http://localhost:${server.port}/api/boards/${boardId}/activity?limit=3`, {
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { entries: unknown[] }).entries).toHaveLength(3);
    });
  });
});
