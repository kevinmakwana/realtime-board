import { vi } from 'vitest';
import {
  stateFromSnapshot,
  type BoardSnapshot,
  type BoardState,
  type Card,
  type Comment,
  type Member,
} from '@board/shared';
import type { BoardClient } from '../src/lib/boardClient';

export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const BOARD = uid(1);
export const ADA = uid(2);
export const GRACE = uid(3);
export const COL_TODO = uid(10);
export const COL_DONE = uid(11);

export const makeCard = (n: number, extra: Partial<Card> = {}): Card => ({
  id: uid(100 + n),
  boardId: BOARD,
  columnId: COL_TODO,
  title: `Card ${n}`,
  description: '',
  position: `a${n}`,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  dueDate: null,
  assigneeIds: [],
  labels: [],
  ...extra,
});

export const makeComment = (n: number, cardId: string, extra: Partial<Comment> = {}): Comment => ({
  id: uid(200 + n),
  boardId: BOARD,
  cardId,
  authorId: ADA,
  authorName: 'Ada Lovelace',
  body: `Comment ${n}`,
  createdAt: '2026-01-01T10:00:00.000Z',
  editedAt: null,
  ...extra,
});

export const ada: Member = { userId: ADA, name: 'Ada Lovelace', color: '#0091ff', role: 'owner' };
export const grace: Member = { userId: GRACE, name: 'Grace Hopper', color: '#e5484d', role: 'editor' };

export function makeState(cards: Card[] = [], comments: Comment[] = []): BoardState {
  const snapshot: BoardSnapshot = {
    board: { id: BOARD, name: 'Roadmap', createdAt: '2026-01-01T00:00:00.000Z' },
    columns: [
      { id: COL_TODO, boardId: BOARD, name: 'To do', position: 'a0' },
      { id: COL_DONE, boardId: BOARD, name: 'Done', position: 'a1' },
    ],
    cards,
    comments,
    seq: 5,
  };
  return stateFromSnapshot(snapshot);
}

const METHODS = [
  'createCard',
  'updateCard',
  'moveCard',
  'deleteCard',
  'addComment',
  'editComment',
  'deleteComment',
  'createColumn',
  'renameColumn',
  'moveColumn',
  'deleteColumn',
  'renameBoard',
  'setEditing',
  'sendCursor',
] as const;

/** A BoardClient whose commands are spies, so a test can assert what a click or keystroke asked for. */
export function fakeClient() {
  const client = Object.fromEntries(METHODS.map((m) => [m, vi.fn()])) as Record<
    (typeof METHODS)[number],
    ReturnType<typeof vi.fn>
  >;
  const notices = new Set<(n: { kind: 'error' | 'info'; message: string }) => void>();
  client.moveCard.mockReturnValue(true);
  client.moveColumn.mockReturnValue(true);
  const extra = {
    onNotice: (fn: (n: { kind: 'error' | 'info'; message: string }) => void) => {
      notices.add(fn);
      return () => notices.delete(fn);
    },
  };
  return Object.assign(client, extra) as typeof client & typeof extra & BoardClient;
}
