import type { Board, BoardEvent, Card, Column, Comment } from '../src/index.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ids = {
  board: uuid(1),
  user: uuid(2),
  colA: uuid(10),
  colB: uuid(11),
  card1: uuid(20),
  card2: uuid(21),
  card3: uuid(22),
};

export const board: Board = { id: ids.board, name: 'Roadmap', createdAt: '2026-01-01T00:00:00.000Z' };
export const column = (id: string, position: string, name = 'Col'): Column => ({
  id,
  boardId: ids.board,
  name,
  position,
});
export const card = (id: string, columnId: string, position: string, extra: Partial<Card> = {}): Card => ({
  id,
  boardId: ids.board,
  columnId,
  title: 'Card',
  description: '',
  position,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  dueDate: null,
  assigneeIds: [],
  labels: [],
  ...extra,
});

export const comment = (id: string, cardId: string, extra: Partial<Comment> = {}): Comment => ({
  id,
  boardId: ids.board,
  cardId,
  authorId: ids.user,
  authorName: 'Ada',
  body: 'hello',
  createdAt: '2026-01-01T00:00:00.000Z',
  editedAt: null,
  ...extra,
});

export const ev = <T extends BoardEvent['type']>(
  seq: number,
  type: T,
  body: Omit<Extract<BoardEvent, { type: T }>, 'seq' | 'type' | 'boardId' | 'actorId' | 'ts'>,
): BoardEvent =>
  ({
    seq,
    type,
    boardId: ids.board,
    actorId: ids.user,
    ts: '2026-01-01T00:00:00.000Z',
    ...body,
  }) as unknown as BoardEvent;
