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

/**
 * What the client knows about a card's unsent comments: the server's record, plus what live events said about
 * comments that are not loaded. A page read from the database may predate such an event, so on merge the event wins.
 */
export type OlderEntry = OlderComments[string] & { touched?: Record<string, Comment | null> };

/** Authoritative board state: only ever changed by sequenced server events. */
export interface BoardState {
  board: Board;
  columns: Record<string, Column>;
  cards: Record<string, Card>;
  comments: Record<string, Comment>;
  /** Cards that have comments the server has not sent yet; see `olderCommentsSchema`. */
  olderComments: Record<string, OlderEntry>;
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
    case 'comment.updated': {
      const entry = state.olderComments[e.comment.cardId];
      if (!state.comments[e.comment.id] && entry) {
        // Not loaded (it is among the card's older ones): show it when that page is loaded, with this edit applied.
        next.olderComments = {
          ...state.olderComments,
          [e.comment.cardId]: { ...entry, touched: { ...entry.touched, [e.comment.id]: e.comment } },
        };
        break;
      }
      next.comments = { ...state.comments, [e.comment.id]: e.comment };
      break;
    }
    case 'comment.deleted': {
      const { [e.commentId]: removed, ...comments } = state.comments;
      next.comments = comments;
      if (!removed) {
        // Not loaded, so it is one of the unsent ones: remember it for the page that may still contain it. When the
        // event names the card, only that card is touched and it has one fewer unloaded comment. Older log entries
        // do not name it, so every card with unloaded comments remembers the id and no count changes.
        const forget = (entry: OlderEntry) => ({ ...entry, touched: { ...entry.touched, [e.commentId]: null } });
        const entry = e.cardId ? state.olderComments[e.cardId] : undefined;
        if (e.cardId && entry) {
          next.olderComments = {
            ...state.olderComments,
            [e.cardId]: { ...forget(entry), count: Math.max(0, entry.count - 1) },
          };
        } else if (!e.cardId) {
          next.olderComments = Object.fromEntries(
            Object.entries(state.olderComments).map(([cardId, o]) => [cardId, forget(o)]),
          );
        }
      }
      break;
    }
  }
  return next;
}

/**
 * Adds a page of a card's older comments (already loaded from the server). Comments we already hold keep their
 * live version, and a comment that live events edited or deleted while the page was on its way gets that outcome
 * rather than what the page says. `nextCursor` is the cursor for the page before this one (null: this was the
 * oldest). `requestCursor` is the cursor the page was requested with; if the card's cursor has moved on since
 * (a new snapshot arrived), the page no longer fits and is dropped.
 */
export function mergeOlderComments(
  state: BoardState,
  cardId: string,
  page: readonly Comment[],
  nextCursor: string | null,
  requestCursor: string,
): BoardState {
  const entry = state.olderComments[cardId];
  if (!entry || entry.cursor !== requestCursor) return state;
  const comments = { ...state.comments };
  let alreadyCounted = 0; // deleted live since the page was read: the count dropped when that event arrived
  for (const c of page) {
    if (c.cardId !== cardId || comments[c.id]) continue;
    const live = entry.touched?.[c.id];
    if (live === null) {
      alreadyCounted++;
      continue;
    }
    comments[c.id] = live ?? c;
  }
  const { [cardId]: _done, ...others } = state.olderComments;
  const olderComments = nextCursor
    ? {
        ...others,
        [cardId]: {
          count: Math.max(0, entry.count - (page.length - alreadyCounted)),
          cursor: nextCursor,
          ...(entry.touched && { touched: entry.touched }),
        },
      }
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
