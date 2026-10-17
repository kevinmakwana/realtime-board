import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { keyBetween } from '@board/shared';
import { ServiceError } from '../src/errors.js';
import { createWorld } from './helpers.js';

const world = createWorld();
afterAll(() => world.close());

/** Two boards owned by one user, each with its default columns. */
async function twoBoards() {
  const user = await world.newUser('Ada');
  const [one, two] = await Promise.all([world.newBoard(user.id), world.newBoard(user.id)]);
  return { user, one, two };
}

const cardOn = (snap: Awaited<ReturnType<typeof world.newBoard>>, id: string) => ({
  id,
  boardId: snap.board.id,
  columnId: snap.columns[0]!.id,
  title: 'Card',
  position: keyBetween(null, null),
});

describe('create commands are idempotent per board, never across boards', () => {
  it('treats a retry of the same create on the same board as a no-op', async () => {
    const { user, one } = await twoBoards();
    const id = randomUUID();
    const first = await world.service.createCard(user.id, cardOn(one, id));
    const retry = await world.service.createCard(user.id, cardOn(one, id));
    expect(first.event).not.toBeNull();
    expect(retry.event).toBeNull();
    expect(retry.seq).toBe(first.seq);
  });

  it('rejects a card id that already belongs to another board, without writing an event', async () => {
    const { user, one, two } = await twoBoards();
    const id = randomUUID();
    await world.service.createCard(user.id, cardOn(one, id));

    await expect(world.service.createCard(user.id, cardOn(two, id))).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(await world.service.latestSeq(two.board.id)).toBe(0);
    const stillThere = await world.service.getSnapshot(one.board.id);
    expect(stillThere?.cards.map((c) => c.id)).toEqual([id]);
  });

  it('rejects a column id that already belongs to another board', async () => {
    const { user, one, two } = await twoBoards();
    const taken = one.columns[0]!.id;
    await expect(
      world.service.createColumn(user.id, {
        id: taken,
        boardId: two.board.id,
        name: 'Stolen',
        position: keyBetween(null, null),
      }),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(await world.service.latestSeq(two.board.id)).toBe(0);
  });

  it('treats a retried column create on the same board as a no-op', async () => {
    const { user, one } = await twoBoards();
    const id = randomUUID();
    const payload = {
      id,
      boardId: one.board.id,
      name: 'Review',
      position: keyBetween(one.columns.at(-1)!.position, null),
    };
    const first = await world.service.createColumn(user.id, payload);
    const retry = await world.service.createColumn(user.id, payload);
    expect(first.event).not.toBeNull();
    expect(retry.event).toBeNull();
  });

  it('rejects a comment id that already belongs to another board, and no-ops a same-board retry', async () => {
    const { user, one, two } = await twoBoards();
    const cardOne = randomUUID();
    const cardTwo = randomUUID();
    await world.service.createCard(user.id, cardOn(one, cardOne));
    await world.service.createCard(user.id, cardOn(two, cardTwo));

    const id = randomUUID();
    const first = await world.service.addComment(user.id, { id, boardId: one.board.id, cardId: cardOne, body: 'hi' });
    const retry = await world.service.addComment(user.id, { id, boardId: one.board.id, cardId: cardOne, body: 'hi' });
    expect(first.event).not.toBeNull();
    expect(retry.event).toBeNull();

    const seqBefore = await world.service.latestSeq(two.board.id);
    await expect(
      world.service.addComment(user.id, { id, boardId: two.board.id, cardId: cardTwo, body: 'hi' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await world.service.latestSeq(two.board.id)).toBe(seqBefore);
  });
});
