import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { keyBetween } from '@board/shared';
import { BACKFILL_OWNERS_SQL } from '../src/migrations.js';
import { createWorld } from './helpers.js';

const world = createWorld();
afterAll(() => world.close());

const addTo = (boardId: string, userId: string, role: 'editor' | 'viewer') =>
  world.pool.query('INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, $3)', [boardId, userId, role]);

const cardOn = (snap: Awaited<ReturnType<typeof world.newBoard>>) => ({
  id: randomUUID(),
  boardId: snap.board.id,
  columnId: snap.columns[0]!.id,
  title: 'Card',
  position: keyBetween(null, null),
});

describe('membership data and enforcement', () => {
  it('makes the creator the owner and filters boards by membership', async () => {
    const ada = await world.newUser('Ada');
    const grace = await world.newUser('Grace');
    const mine = await world.newBoard(ada.id);
    const hers = await world.newBoard(grace.id);

    expect(await world.service.role(mine.board.id, ada.id)).toBe('owner');
    expect(await world.service.role(mine.board.id, grace.id)).toBeNull();

    const adaBoards = await world.service.listBoards(ada.id);
    expect(adaBoards.map((b) => b.id)).toContain(mine.board.id);
    expect(adaBoards.map((b) => b.id)).not.toContain(hers.board.id);
    expect(adaBoards.find((b) => b.id === mine.board.id)?.role).toBe('owner');
  });

  it('backfills an owner row for boards that predate membership, and is safe to run twice', async () => {
    const ada = await world.newUser('Ada');
    const boardId = randomUUID();
    await world.pool.query('INSERT INTO boards (id, name, owner_id) VALUES ($1, $2, $3)', [boardId, 'Legacy', ada.id]);

    await world.pool.query(BACKFILL_OWNERS_SQL);
    await world.pool.query(BACKFILL_OWNERS_SQL);

    expect(await world.service.role(boardId, ada.id)).toBe('owner');
    const { rows } = await world.pool.query('SELECT count(*)::int AS n FROM board_members WHERE board_id = $1', [
      boardId,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it('refuses commands from a non-member as if the board did not exist, writing nothing', async () => {
    const ada = await world.newUser('Ada');
    const stranger = await world.newUser('Stranger');
    const snap = await world.newBoard(ada.id);
    await expect(world.service.createCard(stranger.id, cardOn(snap))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await world.service.latestSeq(snap.board.id)).toBe(0);
  });

  it('refuses commands from a viewer with FORBIDDEN, writing nothing', async () => {
    const ada = await world.newUser('Ada');
    const vic = await world.newUser('Vic');
    const snap = await world.newBoard(ada.id);
    await addTo(snap.board.id, vic.id, 'viewer');
    await expect(world.service.createCard(vic.id, cardOn(snap))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await world.service.latestSeq(snap.board.id)).toBe(0);
  });

  it('lets editors write, and stops a member the moment they are removed', async () => {
    const ada = await world.newUser('Ada');
    const ed = await world.newUser('Ed');
    const snap = await world.newBoard(ada.id, [ed.id]);
    await expect(world.service.createCard(ed.id, cardOn(snap))).resolves.toMatchObject({ seq: 1 });

    await world.pool.query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [snap.board.id, ed.id]);
    await expect(world.service.createCard(ed.id, cardOn(snap))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await world.service.latestSeq(snap.board.id)).toBe(1);
  });
});

describe('reading a board that does not exist', () => {
  it('gives the connection back clean, however many times it happens', async () => {
    // The test pool has 4 connections: leaking one per call would exhaust it (or leave it read-only).
    for (let i = 0; i < 8; i++) expect(await world.service.getSnapshot(randomUUID())).toBeNull();
    const ada = await world.newUser('Ada'); // a write, on a connection that must not be stuck read-only
    expect((await world.newBoard(ada.id)).board.id).toBeTruthy();
  });
});
