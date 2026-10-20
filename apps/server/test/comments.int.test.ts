import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerInstance } from '../src/server.js';
import { addCard, collectEvents, createWorld, emit, join, startPair, type TestWorld } from './helpers.js';

describe('comment edit and delete', () => {
  const world: TestWorld = createWorld();
  let a: ServerInstance;
  let b: ServerInstance;
  beforeAll(async () => {
    [a, b] = await startPair('comments-a', 'comments-b');
  });
  afterAll(async () => {
    await world.close();
    await Promise.all([a.close(), b.close()]);
  });

  /** Ada owns the board, Ed and Eve are editors, Vic is a viewer; Ed has written a comment on a card. */
  async function scene() {
    const [ada, ed, eve, vic] = await Promise.all(['Ada', 'Ed', 'Eve', 'Vic'].map((n) => world.newUser(n)));
    const snap = await world.newBoard(ada!.id, [ed!.id, eve!.id]);
    await world.pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'viewer')", [
      snap.board.id,
      vic!.id,
    ]);
    const [sa, se, sv] = await Promise.all([
      world.connect(a.port, ada!.token),
      world.connect(b.port, ed!.token),
      world.connect(a.port, vic!.token),
    ]);
    await Promise.all([join(sa, snap.board.id), join(se, snap.board.id), join(sv, snap.board.id)]);
    const { id: cardId } = await addCard(sa, snap, 'Card');
    const commentId = randomUUID();
    await emit(se, 'comment:add', { id: commentId, boardId: snap.board.id, cardId, body: 'first draft' });
    return { ada: ada!, ed: ed!, eve: eve!, vic: vic!, snap, cardId, commentId, sa, se, sv };
  }

  describe('edit', () => {
    it('lets the author change the body; everyone sees it, marked as edited', async () => {
      const { snap, commentId, sa, se } = await scene();
      const seen = collectEvents(sa);
      const ack = await emit(se, 'comment:edit', { id: commentId, boardId: snap.board.id, body: '  better  ' });
      expect(ack).toMatchObject({ ok: true });
      // (the scene's own comment.added may still be in flight to this tab, so look for the update)
      await expect.poll(() => seen.some((e) => e.type === 'comment.updated'), { timeout: 5000 }).toBe(true);
      const updated = seen.find((e) => e.type === 'comment.updated');
      expect(updated).toMatchObject({
        type: 'comment.updated',
        comment: { id: commentId, body: 'better', authorName: 'Ed' },
      });
      const comment = (updated as { comment: { editedAt: string | null; createdAt: string } }).comment;
      expect(comment.editedAt).toBeTruthy();
      const stored = await world.service.getSnapshot(snap.board.id);
      expect(stored?.comments.find((c) => c.id === commentId)).toMatchObject({ body: 'better' });
      expect(stored?.comments[0]?.editedAt).toBeTruthy();
    });

    it('writes nothing when the text is unchanged', async () => {
      const { snap, commentId, se } = await scene();
      const before = await world.service.latestSeq(snap.board.id);
      expect(
        await emit(se, 'comment:edit', { id: commentId, boardId: snap.board.id, body: 'first draft' }),
      ).toMatchObject({
        ok: true,
        seq: before,
      });
    });

    it('refuses everyone but the author, including the board owner', async () => {
      const { snap, commentId, sa, sv } = await scene();
      for (const socket of [sa, sv]) {
        const ack = await emit(socket, 'comment:edit', { id: commentId, boardId: snap.board.id, body: 'rewritten' });
        expect(ack).toMatchObject({ ok: false });
        expect(['FORBIDDEN']).toContain(ack.code);
      }
      expect((await world.service.getSnapshot(snap.board.id))?.comments[0]?.body).toBe('first draft');
    });

    it('answers NOT_FOUND for a comment that does not exist or is on another board', async () => {
      const { snap, se } = await scene();
      const other = await scene();
      expect(await emit(se, 'comment:edit', { id: randomUUID(), boardId: snap.board.id, body: 'x' })).toMatchObject({
        ok: false,
        code: 'NOT_FOUND',
      });
      expect(await emit(se, 'comment:edit', { id: other.commentId, boardId: snap.board.id, body: 'x' })).toMatchObject({
        ok: false,
        code: 'NOT_FOUND',
      });
    });

    it('refuses an empty body', async () => {
      const { snap, commentId, se } = await scene();
      expect(await emit(se, 'comment:edit', { id: commentId, boardId: snap.board.id, body: '   ' })).toMatchObject({
        ok: false,
        code: 'VALIDATION',
      });
    });
  });

  describe('delete', () => {
    it('lets the author delete their comment, for everyone', async () => {
      const { snap, commentId, sa, se } = await scene();
      const seen = collectEvents(sa);
      expect(await emit(se, 'comment:delete', { id: commentId, boardId: snap.board.id })).toMatchObject({ ok: true });
      await expect.poll(() => seen.some((e) => e.type === 'comment.deleted'), { timeout: 5000 }).toBe(true);
      expect(seen.find((e) => e.type === 'comment.deleted')).toMatchObject({ type: 'comment.deleted', commentId });
      expect((await world.service.getSnapshot(snap.board.id))?.comments).toEqual([]);
    });

    it('lets the board owner delete someone else’s comment (moderation)', async () => {
      const { snap, commentId, sa } = await scene();
      expect(await emit(sa, 'comment:delete', { id: commentId, boardId: snap.board.id })).toMatchObject({ ok: true });
      expect((await world.service.getSnapshot(snap.board.id))?.comments).toEqual([]);
    });

    it('does not let another editor or a viewer delete it', async () => {
      const { eve, snap, commentId, sv } = await scene();
      const seve = await world.connect(a.port, eve.token);
      await join(seve, snap.board.id);
      expect(await emit(seve, 'comment:delete', { id: commentId, boardId: snap.board.id })).toMatchObject({
        ok: false,
        code: 'FORBIDDEN',
      });
      expect(await emit(sv, 'comment:delete', { id: commentId, boardId: snap.board.id })).toMatchObject({
        ok: false,
        code: 'FORBIDDEN',
      });
      expect((await world.service.getSnapshot(snap.board.id))?.comments).toHaveLength(1);
    });

    it('answers NOT_FOUND the second time', async () => {
      const { snap, commentId, se } = await scene();
      await emit(se, 'comment:delete', { id: commentId, boardId: snap.board.id });
      expect(await emit(se, 'comment:delete', { id: commentId, boardId: snap.board.id })).toMatchObject({
        ok: false,
        code: 'NOT_FOUND',
      });
    });
  });

  it('keeps edits and deletes in the event log, so a reconnecting client replays them', async () => {
    const { snap, commentId, se } = await scene();
    const from = (await world.service.latestSeq(snap.board.id)) ?? 0;
    await emit(se, 'comment:edit', { id: commentId, boardId: snap.board.id, body: 'v2' });
    await emit(se, 'comment:delete', { id: commentId, boardId: snap.board.id });
    const events = await world.service.eventsSince(snap.board.id, from);
    expect(events.map((e) => e.type)).toEqual(['comment.updated', 'comment.deleted']);
  });
});
