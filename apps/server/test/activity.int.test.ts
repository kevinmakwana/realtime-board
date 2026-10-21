import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerInstance } from '../src/server.js';
import { addCard, createWorld, emit, join, startPair, type TestWorld } from './helpers.js';

describe('activity feed', () => {
  const world: TestWorld = createWorld();
  let a: ServerInstance;
  let b: ServerInstance;
  beforeAll(async () => {
    [a, b] = await startPair('activity-a', 'activity-b');
  });
  afterAll(async () => {
    await world.close();
    await Promise.all([a.close(), b.close()]);
  });

  const get = (port: number, token: string, boardId: string, query = '') =>
    fetch(`http://localhost:${port}/api/boards/${boardId}/activity${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });

  async function scene() {
    const ada = await world.newUser('Ada');
    const grace = await world.newUser('Grace');
    const vic = await world.newUser('Vic');
    const stranger = await world.newUser('Stranger');
    const snap = await world.newBoard(ada.id, [grace.id]);
    await world.pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'viewer')", [
      snap.board.id,
      vic.id,
    ]);
    const sa = await world.connect(a.port, ada.token);
    const sg = await world.connect(b.port, grace.token);
    await join(sa, snap.board.id);
    await join(sg, snap.board.id);
    return { ada, grace, vic, stranger, snap, sa, sg, boardId: snap.board.id };
  }

  it('lists what happened, newest first, with who did it and the card titles', async () => {
    const { ada, grace, snap, sa, sg, boardId } = await scene();
    const { id } = await addCard(sa, snap, 'Write docs');
    await emit(sg, 'card:update', { id, boardId, baseVersion: 1, dueDate: '2026-03-15' });
    await emit(sa, 'comment:add', { id: crypto.randomUUID(), boardId, cardId: id, body: 'looks good' });
    await emit(sg, 'card:delete', { id, boardId, baseVersion: 2 });

    const res = await get(a.port, ada.token, boardId);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: { seq: number; actorName: string; text: string }[] };
    expect(entries.map((e) => [e.actorName, e.text])).toEqual([
      ['Grace', 'deleted card “Write docs”'],
      ['Ada', 'commented on “Write docs”'],
      ['Grace', 'updated “Write docs”: set the due date to 2026-03-15'],
      ['Ada', expect.stringMatching(/^added card “Write docs” to “.+”$/)],
    ]);
    expect(entries.map((e) => e.seq)).toEqual([4, 3, 2, 1]);
    expect(grace.id).toBeTruthy();
  });

  it('returns only the most recent `limit` entries, yet still knows titles from before the window', async () => {
    const { ada, snap, sa, boardId } = await scene();
    const { id } = await addCard(sa, snap, 'Old title');
    for (let i = 0; i < 3; i++)
      await emit(sa, 'comment:add', { id: crypto.randomUUID(), boardId, cardId: id, body: `c${i}` });
    await emit(sa, 'card:delete', { id, boardId, baseVersion: 1 });

    const { entries } = (await (await get(a.port, ada.token, boardId, '?limit=2')).json()) as {
      entries: { text: string }[];
    };
    expect(entries.map((e) => e.text)).toEqual(['deleted card “Old title”', 'commented on “Old title”']);
  });

  it('caps and validates the limit', async () => {
    const { ada, boardId } = await scene();
    expect((await get(a.port, ada.token, boardId, '?limit=0')).status).toBe(400);
    expect((await get(a.port, ada.token, boardId, '?limit=abc')).status).toBe(400);
    expect((await get(a.port, ada.token, boardId, '?limit=100000')).status).toBe(200); // clamped, not an error
  });

  it('is readable by a viewer and hidden from non-members as if the board did not exist', async () => {
    const { vic, stranger, boardId } = await scene();
    expect((await get(a.port, vic.token, boardId)).status).toBe(200);
    expect((await get(a.port, stranger.token, boardId)).status).toBe(404);
  });

  it('is empty for a board nothing has happened on', async () => {
    const { ada, boardId } = await scene();
    expect(await (await get(a.port, ada.token, boardId)).json()).toEqual({ entries: [] });
  });
});
