import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyBetween } from '@board/shared';
import type { ServerInstance } from '../src/server.js';
import { addCard, createWorld, emit, join, startInstance, startPair, type TestWorld } from './helpers.js';

describe('version conflicts, validation and rate limiting', () => {
  const world: TestWorld = createWorld();
  let a: ServerInstance;
  let b: ServerInstance;

  beforeAll(async () => {
    [a, b] = await startPair('conflict-a', 'conflict-b');
  });
  afterAll(async () => {
    await world.close();
    await Promise.all([a.close(), b.close()]);
  });

  it('accepts the first writer and rejects a stale update with the current card for resync', async () => {
    const ada = await world.newUser('Ada');
    const grace = await world.newUser('Grace');
    const snap = await world.newBoard(ada.id);
    const sa = await world.connect(a.port, ada.token);
    const sb = await world.connect(b.port, grace.token);
    await join(sa, snap.board.id);
    await join(sb, snap.board.id);
    const { id } = await addCard(sa, snap, 'Original');

    // Both users read v1 and edit concurrently.
    const first = await emit(sa, 'card:update', { id, boardId: snap.board.id, baseVersion: 1, title: 'Ada edit' });
    const second = await emit(sb, 'card:update', { id, boardId: snap.board.id, baseVersion: 1, title: 'Grace edit' });

    expect(first).toMatchObject({ ok: true, version: 2 });
    expect(second).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
    expect(second.current).toMatchObject({ id, title: 'Ada edit', version: 2 });

    // Grace retries on top of the version she just learned about: accepted.
    const retry = await emit(sb, 'card:update', { id, boardId: snap.board.id, baseVersion: 2, title: 'Grace edit' });
    expect(retry).toMatchObject({ ok: true, version: 3 });
  });

  it('rejects a stale move and a stale delete too, leaving the card untouched', async () => {
    const ada = await world.newUser('Ada');
    const snap = await world.newBoard(ada.id);
    const s = await world.connect(a.port, ada.token);
    await join(s, snap.board.id);
    const { id } = await addCard(s, snap, 'Movable');
    await emit(s, 'card:update', { id, boardId: snap.board.id, baseVersion: 1, description: 'bump' });

    const move = await emit(s, 'card:move', {
      id, boardId: snap.board.id, baseVersion: 1, columnId: snap.columns[1]!.id, position: keyBetween(null, null),
    });
    const del = await emit(s, 'card:delete', { id, boardId: snap.board.id, baseVersion: 1 });
    expect(move).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });
    expect(del).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' });

    const after = await world.service.getSnapshot(snap.board.id);
    expect(after!.cards[0]).toMatchObject({ id, columnId: snap.columns[0]!.id, version: 2 });
    expect(after!.seq).toBe(2); // rejected commands must not consume a sequence number
  });

  it('validates payloads with zod and reports field errors', async () => {
    const ada = await world.newUser('Ada');
    const snap = await world.newBoard(ada.id);
    const s = await world.connect(a.port, ada.token);
    await join(s, snap.board.id);
    const bad = await emit(s, 'card:create', { id: 'nope', boardId: snap.board.id, columnId: snap.columns[0]!.id, title: '', position: 'a0' } as any);
    expect(bad).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(bad.message).toMatch(/id/);
    const badKey = await emit(s, 'card:create', {
      id: randomUUID(), boardId: snap.board.id, columnId: snap.columns[0]!.id, title: 'x', position: '!!!',
    });
    expect(badKey).toMatchObject({ ok: false, code: 'VALIDATION' });
  });

  it('treats a retried create as idempotent (no duplicate event)', async () => {
    const ada = await world.newUser('Ada');
    const snap = await world.newBoard(ada.id);
    const s = await world.connect(a.port, ada.token);
    await join(s, snap.board.id);
    const id = randomUUID();
    const payload = { id, boardId: snap.board.id, columnId: snap.columns[0]!.id, title: 'Once', position: 'a0' };
    expect(await emit(s, 'card:create', payload)).toMatchObject({ ok: true, seq: 1 });
    expect(await emit(s, 'card:create', payload)).toMatchObject({ ok: true, seq: 1 });
    expect((await world.service.getSnapshot(snap.board.id))!.cards).toHaveLength(1);
  });
});

describe('per-socket rate limiting', () => {
  const world: TestWorld = createWorld();
  let inst: ServerInstance;
  beforeAll(async () => {
    inst = await startInstance('limited', { RATE_LIMIT_BURST: 5, RATE_LIMIT_PER_SEC: 1 });
  });
  afterAll(async () => {
    await world.close();
    await inst.close();
  });

  it('rejects commands over the burst with RATE_LIMITED, per socket', async () => {
    const ada = await world.newUser('Ada');
    const grace = await world.newUser('Grace');
    const snap = await world.newBoard(ada.id);
    const noisy = await world.connect(inst.port, ada.token);
    const calm = await world.connect(inst.port, grace.token);
    await join(noisy, snap.board.id); // 1 token
    const results = await Promise.all(
      Array.from({ length: 12 }, () => emit(noisy, 'presence:editing', { boardId: snap.board.id, cardId: null })),
    );
    const limited = results.filter((r) => r.code === 'RATE_LIMITED');
    expect(limited.length).toBeGreaterThanOrEqual(6);
    expect(results.some((r) => r.ok)).toBe(true);

    // A different socket has its own bucket and is unaffected.
    expect(await join(calm, snap.board.id)).toMatchObject({ ok: true });
  });
});
