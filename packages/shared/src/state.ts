import type { BoardEvent } from './events.js';
import { compareOrdered } from './ordering.js';
import type { Board, BoardSnapshot, Card, Column, Comment } from './models.js';

/** Authoritative board state: only ever changed by sequenced server events. */
export interface BoardState {
  board: Board;
  columns: Record<string, Column>;
  cards: Record<string, Card>;
  comments: Record<string, Comment>;
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
      break;
    }
    case 'card.created':
    case 'card.updated':
    case 'card.moved':
      next.cards = { ...state.cards, [e.card.id]: e.card };
      break;
    case 'card.deleted': {
      const { [e.cardId]: _removed, ...cards } = state.cards;
      next.cards = cards;
      next.comments = Object.fromEntries(Object.entries(state.comments).filter(([, c]) => c.cardId !== e.cardId));
      break;
    }
    case 'comment.added':
      next.comments = { ...state.comments, [e.comment.id]: e.comment };
      break;
  }
  return next;
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
  | { kind: 'card.update'; id: string; title?: string; description?: string }
  | { kind: 'card.move'; id: string; columnId: string; position: string }
  | { kind: 'card.delete'; id: string }
  | { kind: 'comment.add'; comment: Comment };

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
