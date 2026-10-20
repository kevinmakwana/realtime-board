import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerInstance } from '../src/server.js';
import {
  collectEvents,
  createWorld,
  emit,
  join,
  startPair,
  type TestWorld,
  waitFor,
  waitUntilBlocked,
} from './helpers.js';

describe('board rename and delete', () => {
  const world: TestWorld = createWorld();
  let a: ServerInstance;
  let b: ServerInstance;
  beforeAll(async () => {
    [a, b] = await startPair('boards-a', 'boards-b');
  });
  afterAll(async () => {
    await world.close();
    await Promise.all([a.close(), b.close()]);
  });

  const rest = (port: number, token: string, method: string, path: string) =>
    fetch(`http://localhost:${port}${path}`, { method, headers: { authorization: `Bearer ${token}` } });

  describe('rename', () => {
    it('is sequenced like any change: everyone sees the new name and it is in the snapshot', async () => {
      const ada = await world.newUser('Ada');
      const grace = await world.newUser('Grace');
      const snap = await world.newBoard(ada.id, [grace.id]);
      const sa = await world.connect(a.port, ada.token);
      const sg = await world.connect(b.port, grace.token);
      await join(sa, snap.board.id);
      await join(sg, snap.board.id);
      const seen = collectEvents(sg);

      const ack = await emit(sa, 'board:rename', { boardId: snap.board.id, name: '  Q4 launch  ' });
      expect(ack).toMatchObject({ ok: true, seq: 1 });
      await expect.poll(() => seen.length, { timeout: 5000 }).toBe(1);
      expect(seen[0]).toMatchObject({ type: 'board.renamed', name: 'Q4 launch', actorId: ada.id });
      expect((await world.service.getSnapshot(snap.board.id))?.board.name).toBe('Q4 launch');
      expect((await world.service.listBoards(grace.id)).find((x) => x.id === snap.board.id)?.name).toBe('Q4 launch');
    });

    it('writes nothing when the name is unchanged', async () => {
      const ada = await world.newUser('Ada');
      const snap = await world.newBoard(ada.id);
      const sa = await world.connect(a.port, ada.token);
      await join(sa, snap.board.id);
      expect(await emit(sa, 'board:rename', { boardId: snap.board.id, name: snap.board.name })).toMatchObject({
        ok: true,
        seq: 0,
      });
    });

    it('is for the owner: editors and viewers get FORBIDDEN, a blank name is a validation error', async () => {
      const ada = await world.newUser('Ada');
      const ed = await world.newUser('Ed');
      const vic = await world.newUser('Vic');
      const snap = await world.newBoard(ada.id, [ed.id]);
      await world.pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'viewer')", [
        snap.board.id,
        vic.id,
      ]);
      const [se, sv, so] = await Promise.all([
        world.connect(a.port, ed.token),
        world.connect(a.port, vic.token),
        world.connect(a.port, ada.token),
      ]);
      await Promise.all([join(se, snap.board.id), join(sv, snap.board.id), join(so, snap.board.id)]);

      for (const socket of [se, sv]) {
        expect(await emit(socket, 'board:rename', { boardId: snap.board.id, name: 'Hijacked' })).toMatchObject({
          ok: false,
          code: 'FORBIDDEN',
        });
      }
      expect(await emit(so, 'board:rename', { boardId: snap.board.id, name: '   ' })).toMatchObject({
        ok: false,
        code: 'VALIDATION',
      });
      expect((await world.service.getSnapshot(snap.board.id))?.board.name).toBe(snap.board.name);
      expect(await world.service.latestSeq(snap.board.id)).toBe(0);
    });
  });

  describe('delete', () => {
    it('removes the board and everything on it, and cuts every member off on every instance', async () => {
      const ada = await world.newUser('Ada');
      const grace = await world.newUser('Grace');
      const snap = await world.newBoard(ada.id, [grace.id]);
      const sa = await world.connect(a.port, ada.token);
      const sg = await world.connect(b.port, grace.token);
      await join(sa, snap.board.id);
      await join(sg, snap.board.id);
      await emit(sa, 'card:create', {
        id: crypto.randomUUID(),
        boardId: snap.board.id,
        columnId: snap.columns[0]!.id,
        title: 'Doomed',
        position: 'a0',
      });
      await world.pool.query(
        "INSERT INTO board_invites (board_id, email, role, invited_by) VALUES ($1, 'pending@example.test', 'viewer', $2)",
        [snap.board.id, ada.id],
      );

      const graceCutOff = waitFor(sg, 'board:access', (p) => p.boardId === snap.board.id);
      const adaCutOff = waitFor(sa, 'board:access', (p) => p.boardId === snap.board.id);
      const res = await rest(a.port, ada.token, 'DELETE', `/api/boards/${snap.board.id}`);
      expect(res.status).toBe(200);
      expect(await graceCutOff).toEqual({ boardId: snap.board.id, role: null });
      expect(await adaCutOff).toEqual({ boardId: snap.board.id, role: null });

      expect(await world.service.getSnapshot(snap.board.id)).toBeNull();
      for (const table of ['board_members', 'board_invites', 'columns', 'cards', 'board_events']) {
        const { rows } = await world.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE board_id = $1`, [
          snap.board.id,
        ]);
        expect(rows[0].n, table).toBe(0);
      }
      expect(await join(sg, snap.board.id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect((await rest(a.port, grace.token, 'GET', `/api/boards/${snap.board.id}`)).status).toBe(404);
      expect((await world.service.listBoards(ada.id)).map((x) => x.id)).not.toContain(snap.board.id);
    });

    it('is owner-only: 403 for an editor, 404 for a stranger, 404 the second time', async () => {
      const ada = await world.newUser('Ada');
      const ed = await world.newUser('Ed');
      const stranger = await world.newUser('Stranger');
      const snap = await world.newBoard(ada.id, [ed.id]);

      expect((await rest(a.port, ed.token, 'DELETE', `/api/boards/${snap.board.id}`)).status).toBe(403);
      expect((await rest(a.port, stranger.token, 'DELETE', `/api/boards/${snap.board.id}`)).status).toBe(404);
      expect(await world.service.getSnapshot(snap.board.id)).not.toBeNull();

      expect((await rest(a.port, ada.token, 'DELETE', `/api/boards/${snap.board.id}`)).status).toBe(200);
      expect((await rest(a.port, ada.token, 'DELETE', `/api/boards/${snap.board.id}`)).status).toBe(404);
    });

    it('refuses a join that is still in flight when the board is deleted, instead of sending an empty snapshot', async () => {
      const ada = await world.newUser('Ada');
      const snap = await world.newBoard(ada.id);
      const sa = await world.connect(a.port, ada.token);

      // Freeze the join at its first Redis write (the presence entry) while the board is deleted under it.
      await world.redis.call('CLIENT', 'PAUSE', '800', 'WRITE');
      const joining = join(sa, snap.board.id);
      await new Promise((r) => setTimeout(r, 250));
      await world.pool.query('DELETE FROM boards WHERE id = $1', [snap.board.id]);

      expect(await joining).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      // ...and it left nothing behind on the roster.
      expect(await world.redis.zcard(`presence:idx:${snap.board.id}`)).toBe(0);
    });

    it('waits for a command that is already running, so nothing is written to a board that is gone', async () => {
      const ada = await world.newUser('Ada');
      const snap = await world.newBoard(ada.id);
      const columnId = snap.columns[0]!.id;
      const blocker = await world.pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE cards IN ACCESS EXCLUSIVE MODE'); // stalls the command after its role check
      let command: ReturnType<typeof world.service.createCard>;
      let deleting: Promise<Response> = Promise.resolve(new Response());
      try {
        command = world.service.createCard(ada.id, {
          id: crypto.randomUUID(),
          boardId: snap.board.id,
          columnId,
          title: 'In flight',
          position: 'a0',
        });
        await waitUntilBlocked(world.pool, 1); // the command is stalled on the cards lock
        deleting = rest(a.port, ada.token, 'DELETE', `/api/boards/${snap.board.id}`);
        await waitUntilBlocked(world.pool, 2); // and the delete is queued behind it on the board lock
        expect(await world.service.latestSeq(snap.board.id)).toBe(0); // still there: the delete is queued behind the command
      } finally {
        await blocker.query('COMMIT');
        blocker.release();
      }
      await expect(command).resolves.toMatchObject({ seq: 1 });
      expect((await deleting).status).toBe(200);
      expect(await world.service.latestSeq(snap.board.id)).toBeNull();
    });
  });
});
