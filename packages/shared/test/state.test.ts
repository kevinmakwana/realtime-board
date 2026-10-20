import { describe, expect, it } from 'vitest';
import { applyEvent, applyEvents, applyPending, selectCards, selectColumns, stateFromSnapshot } from '../src/index.js';
import { board, card, column, ev, ids } from './fixtures.js';

const base = () =>
  stateFromSnapshot({
    board,
    columns: [column(ids.colB, 'a1', 'Doing'), column(ids.colA, 'a0', 'Todo')],
    cards: [card(ids.card1, ids.colA, 'a0'), card(ids.card2, ids.colA, 'a1')],
    comments: [],
    seq: 4,
  });

describe('applyEvent', () => {
  it('ignores events at or below the current seq (idempotent replay)', () => {
    const s = base();
    const dup = ev(4, 'card.deleted', { cardId: ids.card1 });
    expect(applyEvent(s, dup)).toBe(s);
    expect(applyEvent(s, ev(2, 'card.deleted', { cardId: ids.card1 }))).toBe(s);
  });

  it('moves a card and bumps seq', () => {
    const moved = card(ids.card1, ids.colB, 'a0', { version: 2 });
    const s = applyEvent(base(), ev(5, 'card.moved', { card: moved }));
    expect(s.seq).toBe(5);
    expect(selectCards(s, ids.colA).map((c) => c.id)).toEqual([ids.card2]);
    expect(selectCards(s, ids.colB)[0]?.version).toBe(2);
  });

  it('sorts columns and cards by fractional position', () => {
    const s = base();
    expect(selectColumns(s).map((c) => c.name)).toEqual(['Todo', 'Doing']);
    expect(selectCards(s, ids.colA).map((c) => c.id)).toEqual([ids.card1, ids.card2]);
  });

  it('cascades column deletes to cards and comments', () => {
    let s = base();
    s = applyEvent(
      s,
      ev(5, 'comment.added', {
        comment: {
          id: ids.card3,
          boardId: ids.board,
          cardId: ids.card1,
          authorId: ids.user,
          authorName: 'Ada',
          body: 'hi',
          createdAt: 'x',
        },
      }),
    );
    s = applyEvent(s, ev(6, 'column.deleted', { columnId: ids.colA }));
    expect(Object.keys(s.cards)).toEqual([]);
    expect(Object.keys(s.comments)).toEqual([]);
    expect(Object.keys(s.columns)).toEqual([ids.colB]);
  });

  it('applyEvents folds in order', () => {
    const s = applyEvents(base(), [
      ev(5, 'card.deleted', { cardId: ids.card1 }),
      ev(6, 'card.updated', { card: card(ids.card2, ids.colA, 'a1', { title: 'Renamed', version: 2 }) }),
    ]);
    expect(s.seq).toBe(6);
    expect(s.cards[ids.card2]?.title).toBe('Renamed');
    expect(s.cards[ids.card1]).toBeUndefined();
  });
});

describe('applyPending (optimistic overlay)', () => {
  it('shows a pending move without touching authoritative state', () => {
    const s = base();
    const view = applyPending(s, [{ kind: 'card.move', id: ids.card1, columnId: ids.colB, position: 'a5' }]);
    expect(view.cards[ids.card1]?.columnId).toBe(ids.colB);
    expect(s.cards[ids.card1]?.columnId).toBe(ids.colA); // rollback = just drop the op
    expect(applyPending(s, []).cards[ids.card1]?.columnId).toBe(ids.colA);
  });

  it('layers several ops in order', () => {
    const view = applyPending(base(), [
      { kind: 'card.update', id: ids.card1, title: 'One' },
      { kind: 'card.update', id: ids.card1, description: 'Two' },
      { kind: 'card.delete', id: ids.card2 },
    ]);
    expect(view.cards[ids.card1]).toMatchObject({ title: 'One', description: 'Two' });
    expect(view.cards[ids.card2]).toBeUndefined();
  });

  it('ignores ops for cards that no longer exist', () => {
    const s = applyEvent(base(), ev(5, 'card.deleted', { cardId: ids.card1 }));
    const view = applyPending(s, [{ kind: 'card.update', id: ids.card1, title: 'ghost' }]);
    expect(view.cards[ids.card1]).toBeUndefined();
  });
});

describe('applyPending: column.move', () => {
  it('reorders columns in the view without touching authoritative state', () => {
    const s = base(); // Todo (a0), Doing (a1)
    const view = applyPending(s, [{ kind: 'column.move', id: ids.colA, position: 'a2' }]);
    expect(selectColumns(view).map((c) => c.name)).toEqual(['Doing', 'Todo']);
    expect(selectColumns(s).map((c) => c.name)).toEqual(['Todo', 'Doing']);
  });

  it('ignores a move for a column that no longer exists', () => {
    const s = base();
    const view = applyPending(s, [{ kind: 'column.move', id: ids.card3, position: 'a9' }]);
    expect(selectColumns(view).map((c) => c.name)).toEqual(['Todo', 'Doing']);
  });
});

describe('applyEvent: column.updated carries a move', () => {
  it('re-sorts columns when the position changes', () => {
    const moved = { ...column(ids.colA, 'a2', 'Todo') };
    const s = applyEvent(base(), ev(5, 'column.updated', { column: moved }));
    expect(selectColumns(s).map((c) => c.name)).toEqual(['Doing', 'Todo']);
  });
});
