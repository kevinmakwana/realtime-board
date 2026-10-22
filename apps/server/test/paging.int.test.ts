import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BoardWithRole } from '@board/shared';
import type { ServerInstance } from '../src/server.js';
import { createWorld, startInstance, type TestWorld } from './helpers.js';

describe('paging', () => {
  const world: TestWorld = createWorld();
  let server: ServerInstance;
  let base: string;
  beforeAll(async () => {
    server = await startInstance('paging-a');
    base = `http://localhost:${server.port}`;
  });
  afterAll(async () => {
    await world.close();
    await server.close();
  });

  const get = async (path: string, token: string) => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, json: (await res.json()) as any };
  };

  describe('boards', () => {
    it('pages newest first, with no repeats and no gaps, and says when there are no more', async () => {
      const owner = await world.newUser();
      const ids: string[] = [];
      for (let i = 0; i < 7; i++) ids.unshift((await world.newBoard(owner.id)).board.id); // newest first

      const seen: string[] = [];
      let cursor: string | null = null;
      const sizes: number[] = [];
      do {
        const res = await get(
          `/api/boards?limit=3${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`,
          owner.token,
        );
        expect(res.status).toBe(200);
        const boards = res.json.boards as BoardWithRole[];
        sizes.push(boards.length);
        seen.push(...boards.map((b) => b.id));
        cursor = res.json.nextCursor;
      } while (cursor);
      expect(sizes).toEqual([3, 3, 1]);
      expect(seen).toEqual(ids);
    });

    it('returns no cursor when everything fits on one page', async () => {
      const owner = await world.newUser();
      await world.newBoard(owner.id);
      const res = await get('/api/boards', owner.token);
      expect(res.json.boards).toHaveLength(1);
      expect(res.json.nextCursor).toBeNull();
    });

    it('is stable when boards share a creation time', async () => {
      const owner = await world.newUser();
      const made = [await world.newBoard(owner.id), await world.newBoard(owner.id), await world.newBoard(owner.id)];
      await world.pool.query('UPDATE boards SET created_at = $1 WHERE id = ANY($2::uuid[])', [
        '2026-01-01T00:00:00.123456Z',
        made.map((m) => m.board.id),
      ]);
      const first = await get('/api/boards?limit=2', owner.token);
      const second = await get(`/api/boards?limit=2&before=${encodeURIComponent(first.json.nextCursor)}`, owner.token);
      const all = [...first.json.boards, ...second.json.boards].map((b: BoardWithRole) => b.id);
      expect(new Set(all).size).toBe(3);
      expect(second.json.nextCursor).toBeNull();
    });

    it('only ever lists boards the caller is a member of, on every page', async () => {
      const ada = await world.newUser();
      const other = await world.newUser();
      for (let i = 0; i < 4; i++) await world.newBoard(other.id);
      const mine = await world.newBoard(ada.id);
      const res = await get('/api/boards?limit=2', ada.token);
      expect(res.json.boards.map((b: BoardWithRole) => b.id)).toEqual([mine.board.id]);
      expect(res.json.nextCursor).toBeNull();
    });

    it.each([
      'limit=0',
      'limit=101',
      'limit=abc',
      'limit=1.5',
      'before=garbage',
      'before=',
      `before=${'A'.repeat(300)}`,
    ])('rejects %s with 400', async (query) => {
      const { token } = await world.newUser();
      expect((await get(`/api/boards?${query}`, token)).status).toBe(400);
    });

    it('rejects a cursor that decodes to nonsense', async () => {
      const { token } = await world.newUser();
      const bad = Buffer.from(`not-a-date|${randomUUID()}`).toString('base64url');
      expect((await get(`/api/boards?before=${bad}`, token)).status).toBe(400);
    });
  });

  describe('comments', () => {
    /** Adds `n` comments to a card, oldest first: "c1" is the oldest. Bulk insert, so a test can have hundreds. */
    async function seedComments(boardId: string, cardId: string, authorId: string, n: number) {
      await world.pool.query(
        `INSERT INTO comments (id, board_id, card_id, author_id, body, created_at)
         SELECT gen_random_uuid(), $1, $2, $3, 'c' || i, now() - interval '1 hour' + (i * interval '1 second')
           FROM generate_series(1, $4) AS i`,
        [boardId, cardId, authorId, n],
      );
    }
    const newCard = async (ownerId: string) => {
      const snap = await world.newBoard(ownerId);
      const id = randomUUID();
      await world.service.createCard(ownerId, {
        id,
        boardId: snap.board.id,
        columnId: snap.columns[0]!.id,
        title: 'Busy',
        position: 'a0',
      });
      return { boardId: snap.board.id, cardId: id };
    };
    const page = (boardId: string, cardId: string, token: string, query = '') =>
      get(`/api/boards/${boardId}/cards/${cardId}/comments${query}`, token);

    it('sends only the newest 50 comments of a busy card, and says how many were left out', async () => {
      const owner = await world.newUser();
      const { boardId, cardId } = await newCard(owner.id);
      await seedComments(boardId, cardId, owner.id, 120);
      const quiet = randomUUID();
      await world.service.createCard(owner.id, {
        id: quiet,
        boardId,
        columnId: (await world.service.getSnapshot(boardId))!.columns[0]!.id,
        title: 'Quiet',
        position: 'a1',
      });
      await seedComments(boardId, quiet, owner.id, 3);

      const snap = (await world.service.getSnapshot(boardId))!;
      const busy = snap.comments.filter((c) => c.cardId === cardId).map((c) => c.body);
      expect(busy).toHaveLength(50);
      expect(busy[0]).toBe('c71'); // oldest of the newest 50, in order
      expect(busy.at(-1)).toBe('c120');
      expect(snap.comments.filter((c) => c.cardId === quiet)).toHaveLength(3);
      expect(snap.olderComments).toEqual({ [cardId]: { count: 70, cursor: expect.any(String) } });
    });

    it('omits olderComments when every comment fits', async () => {
      const owner = await world.newUser();
      const { boardId, cardId } = await newCard(owner.id);
      await seedComments(boardId, cardId, owner.id, 50);
      const snap = (await world.service.getSnapshot(boardId))!;
      expect(snap.comments).toHaveLength(50);
      expect(snap.olderComments).toBeUndefined();
    });

    it('pages backwards from the snapshot cursor to the very first comment, once each, oldest first within a page', async () => {
      const owner = await world.newUser();
      const { boardId, cardId } = await newCard(owner.id);
      await seedComments(boardId, cardId, owner.id, 120);
      const snap = (await world.service.getSnapshot(boardId))!;
      let cursor: string | null = snap.olderComments![cardId]!.cursor;
      const bodies: string[] = [];
      const sizes: number[] = [];
      while (cursor) {
        const res = await page(boardId, cardId, owner.token, `?limit=30&before=${encodeURIComponent(cursor)}`);
        expect(res.status).toBe(200);
        sizes.push(res.json.comments.length);
        bodies.unshift(...res.json.comments.map((c: { body: string }) => c.body));
        expect(res.json.comments[0].authorName).toBeTruthy();
        cursor = res.json.nextCursor;
      }
      expect(sizes).toEqual([30, 30, 10]);
      expect(bodies).toEqual(Array.from({ length: 70 }, (_, i) => `c${i + 1}`)); // c1..c70: no gaps, no repeats
    });

    it('is stable when comments share a creation time', async () => {
      const owner = await world.newUser();
      const { boardId, cardId } = await newCard(owner.id);
      await world.pool.query(
        `INSERT INTO comments (id, board_id, card_id, author_id, body, created_at)
         SELECT gen_random_uuid(), $1, $2, $3, 'same' || i, '2026-01-01T00:00:00.5Z' FROM generate_series(1, 7) AS i`,
        [boardId, cardId, owner.id],
      );
      const seen: string[] = [];
      let before = '';
      for (let guard = 0; guard < 10; guard++) {
        const res = await page(boardId, cardId, owner.token, `?limit=3${before}`);
        seen.push(...res.json.comments.map((c: { body: string }) => c.body));
        if (!res.json.nextCursor) break;
        before = `&before=${encodeURIComponent(res.json.nextCursor)}`;
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    });

    it('lets a viewer read older comments and keeps strangers and other boards out', async () => {
      const owner = await world.newUser();
      const viewer = await world.newUser();
      const stranger = await world.newUser();
      const { boardId, cardId } = await newCard(owner.id);
      await world.pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'viewer')", [
        boardId,
        viewer.id,
      ]);
      await seedComments(boardId, cardId, owner.id, 5);
      expect((await page(boardId, cardId, viewer.token)).status).toBe(200);
      expect((await page(boardId, cardId, stranger.token)).status).toBe(404);
      // A card id from a different board is not found through this board.
      const elsewhere = await newCard(owner.id);
      expect((await page(boardId, elsewhere.cardId, owner.token)).status).toBe(404);
      expect((await page(boardId, randomUUID(), owner.token)).status).toBe(404);
    });

    it.each(['limit=0', 'limit=101', 'limit=x', 'before=garbage'])('rejects %s with 400', async (query) => {
      const owner = await world.newUser();
      const { boardId, cardId } = await newCard(owner.id);
      expect((await page(boardId, cardId, owner.token, `?${query}`)).status).toBe(400);
    });
  });
});
