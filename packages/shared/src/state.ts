import type { BoardEvent } from './events.js';
import { compareOrdered } from './ordering.js';
import {
  type Board,
  type BoardSnapshot,
  type Card,
  type Column,
  type Comment,
  type OlderComments,
  normalizeCard,
} from './models.js';

/** Authoritative board state: only ever changed by sequenced server events. */
export interface BoardState {
  board: Board;
  columns: Record<string, Column>;
  cards: Record<string, Card>;
  comments: Record<string, Comment>;
  /** Cards that have comments the server has not sent yet; see `olderCommentsSchema`. */
  olderComments: OlderComments;
  /** Highest event seq applied. */
  seq: number;
}

const byId = <T extends { id: string }>(items: T[]): Record<string, T> =>
  Object.fromEntries(items.map((i) => [i.id, i]));

export function stateFromSnapshot(s: BoardSnapshot): BoardState {
  return {
    board: s.board,
    columns: byId(s.columns),
    cards: byId(s.cards),
    comments: byId(s.comments),
    olderComments: s.olderComments ?? {},
    seq: s.seq,
  };
}

/**
 * Pure, idempotent reducer. Events at or below the current seq are ignored,
 * so replays and duplicate deliveries (room broadcast + catch-up) are harmless.
 * Callers must feed events in order - see `SeqBuffer`.
 */
export function applyEvent(state: BoardState, e: BoardEvent): BoardState {
  if (e.seq <= state.seq) return state;
  const next: BoardState = { ...state, seq: e.seq };
  switch (e.type) {
    case 'board.renamed':
      next.board = { ...state.board, name: e.name };
      break;
    case 'column.created':
    case 'column.updated':
      next.columns = { ...state.columns, [e.column.id]: e.column };
      break;
    case 'column.deleted': {
      const { [e.columnId]: _removed, ...columns } = state.columns;
      next.columns = columns;
      const doomed = new Set(
        Object.values(state.cards)
          .filter((c) => c.columnId === e.columnId)
          .map((c) => c.id),
      );
      next.cards = Object.fromEntries(Object.entries(state.cards).filter(([id]) => !doomed.has(id)));
      next.comments = Object.fromEntries(Object.entries(state.comments).filter(([, c]) => !doomed.has(c.cardId)));
      next.olderComments = Object.fromEntries(Object.entries(state.olderComments).filter(([id]) => !doomed.has(id)));
      break;
    }
    case 'card.created':
    case 'card.updated':
    case 'card.moved':
      next.cards = { ...state.cards, [e.card.id]: normalizeCard(e.card) };
      break;
    case 'card.deleted': {
      const { [e.cardId]: _removed, ...cards } = state.cards;
      next.cards = cards;
      next.comments = Object.fromEntries(Object.entries(state.comments).filter(([, c]) => c.cardId !== e.cardId));
      const { [e.cardId]: _older, ...olderComments } = state.olderComments;
      next.olderComments = olderComments;
      break;
    }
    case 'comment.added':
      next.comments = { ...state.comments, [e.comment.id]: e.comment };
      break;
    case 'comment.updated':
      // An edit to a comment we have not loaded (it is among a card's older ones) arrives when that page is loaded.
      if (!state.comments[e.comment.id] && state.olderComments[e.comment.cardId]) break;
      next.comments = { ...state.comments, [e.comment.id]: e.comment };
      break;
    case 'comment.deleted': {
      const { [e.commentId]: _removed, ...comments } = state.comments;
      next.comments = comments;
      break;
    }
  }
  return next;
}

/**
 * Adds a page of a card's older comments (already loaded from the server). Comments we already hold keep their
 * live version. `nextCursor` is the cursor for the page before this one, or null when this was the oldest.
 */
export function mergeOlderComments(
  state: BoardState,
  cardId: string,
  page: readonly Comment[],
  nextCursor: string | null,
): BoardState {
  const comments = { ...state.comments };
  for (const c of page) if (!comments[c.id] && c.cardId === cardId) comments[c.id] = c;
  const { [cardId]: previous, ...others } = state.olderComments;
  const olderComments = nextCursor
    ? { ...others, [cardId]: { count: Math.max(0, (previous?.count ?? 0) - page.length), cursor: nextCursor } }
    : others;
  return { ...state, comments, olderComments };
}

export function applyEvents(state: BoardState, events: readonly BoardEvent[]): BoardState {
  return events.reduce(applyEvent, state);
}

/* ------------------------------------------------------------------ */
/* Optimistic overlay                                                  */
/* ------------------------------------------------------------------ */

/** A local change that has been sent but not yet confirmed by the event log. */
export type PendingOp =
  | { kind: 'board.rename'; name: string }
  | { kind: 'column.create'; column: Column }
  | { kind: 'column.rename'; id: string; name: string }
  | { kind: 'column.delete'; id: string }
  | { kind: 'column.move'; id: string; position: string }
  | { kind: 'card.create'; card: Card }
  | {
      kind: 'card.update';
      id: string;
      title?: string;
      description?: string;
      dueDate?: string | null;
      assigneeIds?: string[];
      labels?: string[];
    }
  | { kind: 'card.move'; id: string; columnId: string; position: string }
  | { kind: 'card.delete'; id: string }
  | { kind: 'comment.add'; comment: Comment }
  | { kind: 'comment.edit'; id: string; body: string }
  | { kind: 'comment.delete'; id: string };

/** Project pending local ops on top of the authoritative state to get the view state. */
export function applyPending(state: BoardState, ops: readonly PendingOp[]): BoardState {
  let s = state;
  for (const op of ops) {
    switch (op.kind) {
      case 'board.rename':
        s = { ...s, board: { ...s.board, name: op.name } };
        break;
      case 'column.create':
        s = { ...s, columns: { ...s.columns, [op.column.id]: op.column } };
        break;
      case 'column.rename': {
        const col = s.columns[op.id];
        if (col) s = { ...s, columns: { ...s.columns, [op.id]: { ...col, name: op.name } } };
        break;
      }
      case 'column.move': {
        const col = s.columns[op.id];
        if (col) s = { ...s, columns: { ...s.columns, [op.id]: { ...col, position: op.position } } };
        break;
      }
      case 'column.delete': {
        const { [op.id]: _c, ...columns } = s.columns;
        s = {
          ...s,
          columns,
          cards: Object.fromEntries(Object.entries(s.cards).filter(([, c]) => c.columnId !== op.id)),
        };
        break;
      }
      case 'card.create':
        s = { ...s, cards: { ...s.cards, [op.card.id]: op.card } };
        break;
      case 'card.update': {
        const card = s.cards[op.id];
        if (card) {
          s = {
            ...s,
            cards: {
              ...s.cards,
              [op.id]: {
                ...card,
                ...(op.title !== undefined && { title: op.title }),
                ...(op.description !== undefined && { description: op.description }),
                ...(op.dueDate !== undefined && { dueDate: op.dueDate }),
                ...(op.assigneeIds !== undefined && { assigneeIds: op.assigneeIds }),
                ...(op.labels !== undefined && { labels: op.labels }),
              },
            },
          };
        }
        break;
      }
      case 'card.move': {
        const card = s.cards[op.id];
        if (card) {
          s = { ...s, cards: { ...s.cards, [op.id]: { ...card, columnId: op.columnId, position: op.position } } };
        }
        break;
      }
      case 'card.delete': {
        const { [op.id]: _d, ...cards } = s.cards;
        s = { ...s, cards };
        break;
      }
      case 'comment.add':
        s = { ...s, comments: { ...s.comments, [op.comment.id]: op.comment } };
        break;
      case 'comment.edit': {
        const c = s.comments[op.id];
        if (c) s = { ...s, comments: { ...s.comments, [op.id]: { ...c, body: op.body } } };
        break;
      }
      case 'comment.delete': {
        const { [op.id]: _gone, ...comments } = s.comments;
        s = { ...s, comments };
        break;
      }
    }
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Selectors                                                           */
/* ------------------------------------------------------------------ */

export const selectColumns = (s: BoardState): Column[] => Object.values(s.columns).sort(compareOrdered);

export const selectCards = (s: BoardState, columnId: string): Card[] =>
  Object.values(s.cards)
    .filter((c) => c.columnId === columnId)
    .sort(compareOrdered);

export const selectComments = (s: BoardState, cardId: string): Comment[] =>
  Object.values(s.comments)
    .filter((c) => c.cardId === cardId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
