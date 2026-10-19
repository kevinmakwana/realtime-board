import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyBetween } from '@board/shared';
import type { ServerInstance } from '../src/server.js';
import { collectEvents, createWorld, emit, join, startPair, type TestWorld, waitFor } from './helpers.js';

describe('socket access control across two instances', () => {
  const world: TestWorld = createWorld();
  let a: ServerInstance;
  let b: ServerInstance;
  beforeAll(async () => {
    [a, b] = await startPair('access-a', 'access-b');
  });
  afterAll(async () => {
    await world.close();
    await Promise.all([a.close(), b.close()]);
  });

  const rest = (port: number, token: string, method: string, path: string, body?: unknown) =>
    fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  const newCard = (boardId: string, columnId: string) => ({
    id: randomUUID(),
    boardId,
    columnId,
    title: 'Card',
    position: keyBetween(null, null),
  });

  it('refuses a non-member join like a missing board, and reports the role on a successful join', async () => {
    const ada = await world.newUser('Ada');
    const stranger = await world.newUser('Stranger');
    const snap = await world.newBoard(ada.id);

    const s = await world.connect(a.port, stranger.token);
    expect(await join(s, snap.board.id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await emit(s, 'card:create', newCard(snap.board.id, snap.columns[0]!.id))).toMatchObject({
      ok: false,
      code: 'NOT_JOINED',
    });

    const owner = await world.connect(b.port, ada.token);
    expect(await join(owner, snap.board.id)).toMatchObject({ ok: true, role: 'owner' });
  });

  it('lets a viewer read and appear in presence but refuses every write without broadcasting', async () => {
    const ada = await world.newUser('Ada');
    const vic = await world.newUser('Vic');
    const snap = await world.newBoard(ada.id);
    await world.pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'viewer')", [
      snap.board.id,
      vic.id,
    ]);

    const sv = await world.connect(a.port, vic.token);
    const so = await world.connect(b.port, ada.token);
    expect(await join(sv, snap.board.id)).toMatchObject({ ok: true, role: 'viewer' });
    await join(so, snap.board.id);
    const seen = collectEvents(so);

    const refused = await emit(sv, 'card:create', newCard(snap.board.id, snap.columns[0]!.id));
    expect(refused).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toHaveLength(0);
    expect(await world.service.latestSeq(snap.board.id)).toBe(0);
  });

  it('downgrades a live editor on the other instance to viewer', async () => {
    const ada = await world.newUser('Ada');
    const ed = await world.newUser('Ed');
    const snap = await world.newBoard(ada.id, [ed.id]);
    const se = await world.connect(b.port, ed.token);
    await join(se, snap.board.id);
    expect(await emit(se, 'card:create', newCard(snap.board.id, snap.columns[0]!.id))).toMatchObject({ ok: true });

    const access = waitFor(se, 'board:access', (p) => p.boardId === snap.board.id);
    const res = await rest(a.port, ada.token, 'PATCH', `/api/boards/${snap.board.id}/members/${ed.id}`, {
      role: 'viewer',
    });
    expect(res.status).toBe(200);
    expect(await access).toEqual({ boardId: snap.board.id, role: 'viewer' });

    expect(await emit(se, 'card:create', newCard(snap.board.id, snap.columns[0]!.id))).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('removes a live member on the other instance: no more events, gone from presence, join refused', async () => {
    const ada = await world.newUser('Ada');
    const ed = await world.newUser('Ed');
    const snap = await world.newBoard(ada.id, [ed.id]);
    const se = await world.connect(b.port, ed.token);
    const so = await world.connect(a.port, ada.token);
    await join(se, snap.board.id);
    await join(so, snap.board.id);
    const edEvents = collectEvents(se);

    const access = waitFor(se, 'board:access', (p) => p.boardId === snap.board.id);
    const roster = waitFor(
      so,
      'presence:update',
      (p) => p.boardId === snap.board.id && !p.members.some((m) => m.user.id === ed.id),
    );
    const res = await rest(a.port, ada.token, 'DELETE', `/api/boards/${snap.board.id}/members/${ed.id}`);
    expect(res.status).toBe(200);
    expect(await access).toEqual({ boardId: snap.board.id, role: null });
    await roster;

    await emit(so, 'card:create', newCard(snap.board.id, snap.columns[0]!.id));
    await new Promise((r) => setTimeout(r, 300));
    expect(edEvents).toHaveLength(0);

    expect(await emit(se, 'card:create', newCard(snap.board.id, snap.columns[0]!.id))).toMatchObject({
      ok: false,
      code: 'NOT_JOINED',
    });
    expect(await join(se, snap.board.id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('does not let a removal that lands mid-join be lost: the join is refused and the socket gets no events', async () => {
    const ada = await world.newUser('Ada');
    const ed = await world.newUser('Ed');
    const snap = await world.newBoard(ada.id, [ed.id]);
    const se = await world.connect(a.port, ed.token);
    const so = await world.connect(b.port, ada.token);
    await join(so, snap.board.id);
    const seen = collectEvents(se);

    // Stall the join after its role check (it reads `boards` next), then remove Ed meanwhile.
    const blocker = await world.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE boards IN ACCESS EXCLUSIVE MODE');
    const joining = join(se, snap.board.id);
    try {
      await new Promise((r) => setTimeout(r, 300));
      await world.pool.query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [snap.board.id, ed.id]);
      b.io.serverSideEmit('access:changed', { boardId: snap.board.id, userId: ed.id, role: null });
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }

    expect(await joining).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    await emit(so, 'card:create', newCard(snap.board.id, snap.columns[0]!.id));
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toHaveLength(0);
  });
});
