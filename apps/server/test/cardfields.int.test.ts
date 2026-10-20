import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerInstance } from '../src/server.js';
import { addCard, collectEvents, createWorld, emit, join, startPair, type TestWorld } from './helpers.js';

describe('card due dates, assignees and labels', () => {
  const world: TestWorld = createWorld();
  let a: ServerInstance;
  let b: ServerInstance;
  beforeAll(async () => {
    [a, b] = await startPair('fields-a', 'fields-b');
  });
  afterAll(async () => {
    await world.close();
    await Promise.all([a.close(), b.close()]);
  });

  /** Ada owns the board; Grace is an editor, Vic a viewer, Stranger is not on it. A card exists. */
  async function scene() {
    const [ada, grace, vic, stranger] = await Promise.all(
      ['Ada', 'Grace', 'Vic', 'Stranger'].map((n) => world.newUser(n)),
    );
    const snap = await world.newBoard(ada!.id, [grace!.id]);
    await world.pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'viewer')", [
      snap.board.id,
      vic!.id,
    ]);
    const sa = await world.connect(a.port, ada!.token);
    await join(sa, snap.board.id);
    const { id } = await addCard(sa, snap, 'Card');
    const stored = async () => (await world.service.getSnapshot(snap.board.id))!.cards.find((c) => c.id === id)!;
    return { ada: ada!, grace: grace!, vic: vic!, stranger: stranger!, snap, id, sa, stored, boardId: snap.board.id };
  }

  it('starts every card with no date, nobody assigned and no labels', async () => {
    const { stored } = await scene();
    expect(await stored()).toMatchObject({ dueDate: null, assigneeIds: [], labels: [] });
  });

  it('sets all three at once, and the other instance receives them in the event', async () => {
    const { ada, grace, id, boardId, snap, stored } = await scene();
    const sg = await world.connect(b.port, grace.token);
    await join(sg, snap.board.id);
    const seen = collectEvents(sg);
    const sa = await world.connect(a.port, ada.token);
    await join(sa, boardId);

    const ack = await emit(sa, 'card:update', {
      id,
      boardId,
      baseVersion: 1,
      dueDate: '2026-03-15',
      assigneeIds: [ada.id, grace.id],
      labels: ['bug', 'ui'],
    });
    expect(ack).toMatchObject({ ok: true, version: 2 });
    await expect.poll(() => seen.some((e) => e.type === 'card.updated'), { timeout: 5000 }).toBe(true);
    const event = seen.find((e) => e.type === 'card.updated') as { card: Record<string, unknown> };
    expect(event.card).toMatchObject({ dueDate: '2026-03-15', assigneeIds: [ada.id, grace.id], labels: ['bug', 'ui'] });
    expect(await stored()).toMatchObject({
      dueDate: '2026-03-15',
      assigneeIds: [ada.id, grace.id],
      labels: ['bug', 'ui'],
      version: 2,
    });
  });

  it('changes one field without touching the others, and clears them with null and empty lists', async () => {
    const { ada, id, boardId, sa, stored } = await scene();
    await emit(sa, 'card:update', {
      id,
      boardId,
      baseVersion: 1,
      dueDate: '2026-03-15',
      assigneeIds: [ada.id],
      labels: ['bug'],
    });
    await emit(sa, 'card:update', { id, boardId, baseVersion: 2, labels: ['bug', 'ui'] });
    expect(await stored()).toMatchObject({ dueDate: '2026-03-15', assigneeIds: [ada.id], labels: ['bug', 'ui'] });

    await emit(sa, 'card:update', { id, boardId, baseVersion: 3, dueDate: null, assigneeIds: [], labels: [] });
    expect(await stored()).toMatchObject({ dueDate: null, assigneeIds: [], labels: [], version: 4 });
  });

  it('keeps a date exactly as written, whatever the server’s time zone', async () => {
    const { id, boardId, sa, stored } = await scene();
    for (const day of ['2026-01-01', '2026-12-31', '2028-02-29']) {
      const { version } = await stored();
      await emit(sa, 'card:update', { id, boardId, baseVersion: version, dueDate: day });
      expect((await stored()).dueDate).toBe(day);
    }
  });

  it('only assigns members of the board, and a viewer can be assigned', async () => {
    const { ada, vic, stranger, id, boardId, sa, stored } = await scene();
    const refused = await emit(sa, 'card:update', { id, boardId, baseVersion: 1, assigneeIds: [ada.id, stranger.id] });
    expect(refused).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(await stored()).toMatchObject({ assigneeIds: [], version: 1 }); // nothing changed, no version bump

    expect(await emit(sa, 'card:update', { id, boardId, baseVersion: 1, assigneeIds: [vic.id] })).toMatchObject({
      ok: true,
    });
    expect((await stored()).assigneeIds).toEqual([vic.id]);
  });

  it('collapses repeated assignees and labels that differ only in case', async () => {
    const { ada, id, boardId, sa, stored } = await scene();
    await emit(sa, 'card:update', {
      id,
      boardId,
      baseVersion: 1,
      assigneeIds: [ada.id, ada.id],
      labels: ['Bug', 'bug', ' BUG ', 'ui'],
    });
    expect(await stored()).toMatchObject({ assigneeIds: [ada.id], labels: ['Bug', 'ui'] });
  });

  it('is version-checked like any other edit, and viewers cannot change fields', async () => {
    const { vic, id, boardId, sa, snap } = await scene();
    await emit(sa, 'card:update', { id, boardId, baseVersion: 1, labels: ['a'] });
    expect(await emit(sa, 'card:update', { id, boardId, baseVersion: 1, labels: ['b'] })).toMatchObject({
      ok: false,
      code: 'VERSION_CONFLICT',
    });
    const sv = await world.connect(a.port, vic.token);
    await join(sv, snap.board.id);
    expect(await emit(sv, 'card:update', { id, boardId, baseVersion: 2, dueDate: '2026-03-15' })).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('rejects an impossible date and too many labels before touching the card', async () => {
    const { id, boardId, sa, stored } = await scene();
    expect(await emit(sa, 'card:update', { id, boardId, baseVersion: 1, dueDate: '2026-02-30' })).toMatchObject({
      ok: false,
      code: 'VALIDATION',
    });
    expect(
      await emit(sa, 'card:update', { id, boardId, baseVersion: 1, labels: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    ).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect((await stored()).version).toBe(1);
  });
});
