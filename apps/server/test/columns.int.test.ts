import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyBetween, selectColumns, stateFromSnapshot, applyEvents } from '@board/shared';
import type { ServerInstance } from '../src/server.js';
import { collectEvents, createWorld, emit, join, startPair, type TestWorld } from './helpers.js';

describe('column reorder', () => {
  const world: TestWorld = createWorld();
  let a: ServerInstance;
  let b: ServerInstance;
  beforeAll(async () => {
    [a, b] = await startPair('columns-a', 'columns-b');
  });
  afterAll(async () => {
    await world.close();
    await Promise.all([a.close(), b.close()]);
  });

  it('moves a column, and everyone on every instance converges on the new order', async () => {
    const ada = await world.newUser('Ada');
    const grace = await world.newUser('Grace');
    const snap = await world.newBoard(ada.id, [grace.id]);
    const [todo, doing, done] = snap.columns;
    const sa = await world.connect(a.port, ada.token);
    const sg = await world.connect(b.port, grace.token);
    await join(sa, snap.board.id);
    await join(sg, snap.board.id);
    const seen = collectEvents(sg);

    const ack = await emit(sa, 'column:move', {
      id: todo!.id,
      boardId: snap.board.id,
      position: keyBetween(done!.position, null),
    });
    expect(ack).toMatchObject({ ok: true, seq: 1 });
    await expect.poll(() => seen.length, { timeout: 5000 }).toBe(1);
    expect(seen[0]).toMatchObject({ type: 'column.updated', column: { id: todo!.id } });

    const state = applyEvents(stateFromSnapshot(snap), seen);
    expect(selectColumns(state).map((c) => c.name)).toEqual([doing!.name, done!.name, todo!.name]);
  });

  it('is a no-op when the column is already at that position', async () => {
    const ada = await world.newUser('Ada');
    const snap = await world.newBoard(ada.id);
    const sa = await world.connect(a.port, ada.token);
    await join(sa, snap.board.id);
    const seen = collectEvents(sa);
    const ack = await emit(sa, 'column:move', {
      id: snap.columns[0]!.id,
      boardId: snap.board.id,
      position: snap.columns[0]!.position,
    });
    expect(ack).toMatchObject({ ok: true, seq: 0 });
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toEqual([]);
  });

  it('gives a concurrent drop into the same gap a fresh key instead of a duplicate', async () => {
    const ada = await world.newUser('Ada');
    const snap = await world.newBoard(ada.id);
    const [todo, doing] = snap.columns;
    const sa = await world.connect(a.port, ada.token);
    await join(sa, snap.board.id);
    // Both want the key currently held by the third column.
    const taken = snap.columns[2]!.position;
    await emit(sa, 'column:move', { id: todo!.id, boardId: snap.board.id, position: taken });
    await emit(sa, 'column:move', { id: doing!.id, boardId: snap.board.id, position: taken });
    const fresh = await world.service.getSnapshot(snap.board.id);
    const positions = fresh!.columns.map((c) => c.position);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('refuses a viewer, a column of another board, and a malformed key', async () => {
    const ada = await world.newUser('Ada');
    const vic = await world.newUser('Vic');
    const snap = await world.newBoard(ada.id);
    const other = await world.newBoard(ada.id);
    await world.pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'viewer')", [
      snap.board.id,
      vic.id,
    ]);
    const sv = await world.connect(a.port, vic.token);
    const sa = await world.connect(a.port, ada.token);
    await join(sv, snap.board.id);
    await join(sa, snap.board.id);

    const position = keyBetween(null, null);
    expect(await emit(sv, 'column:move', { id: snap.columns[0]!.id, boardId: snap.board.id, position })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(await emit(sa, 'column:move', { id: other.columns[0]!.id, boardId: snap.board.id, position })).toMatchObject(
      {
        ok: false,
        code: 'NOT_FOUND',
      },
    );
    expect(
      await emit(sa, 'column:move', { id: snap.columns[0]!.id, boardId: snap.board.id, position: '!!' }),
    ).toMatchObject({
      ok: false,
      code: 'VALIDATION',
    });
    expect(await world.service.latestSeq(snap.board.id)).toBe(0);
  });
});
