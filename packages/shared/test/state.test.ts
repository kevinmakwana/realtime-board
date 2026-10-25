import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  applyEvents,
  applyPending,
  mergeOlderComments,
  normalizeCard,
  selectCards,
  selectColumns,
  stateFromSnapshot,
} from '../src/index.js';
import { board, card, column, comment, ev, ids } from './fixtures.js';

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
          editedAt: null,
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

describe('board rename', () => {
  it('applies board.renamed to the board name and seq', () => {
    const s = applyEvent(base(), ev(5, 'board.renamed', { name: 'Q4 launch' }));
    expect(s.board.name).toBe('Q4 launch');
    expect(s.seq).toBe(5);
  });

  it('shows a pending rename in the view only', () => {
    const s = base();
    const view = applyPending(s, [{ kind: 'board.rename', name: 'Draft name' }]);
    expect(view.board.name).toBe('Draft name');
    expect(s.board.name).toBe('Roadmap');
  });
});

describe('comment edits and deletes', () => {
  const withComment = () =>
    applyEvent(base(), ev(5, 'comment.added', { comment: comment(ids.card3, ids.card1, { body: 'first draft' }) }));

  it('replaces the comment when it is updated', () => {
    const edited = comment(ids.card3, ids.card1, { body: 'better', editedAt: '2026-01-02T00:00:00.000Z' });
    const s = applyEvent(withComment(), ev(6, 'comment.updated', { comment: edited }));
    expect(s.comments[ids.card3]?.body).toBe('better');
    expect(s.comments[ids.card3]?.editedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(s.seq).toBe(6);
  });

  it('removes the comment when it is deleted, and tolerates a repeat', () => {
    const s = applyEvent(withComment(), ev(6, 'comment.deleted', { commentId: ids.card3 }));
    expect(Object.keys(s.comments)).toEqual([]);
    expect(applyEvent(s, ev(6, 'comment.deleted', { commentId: ids.card3 }))).toBe(s); // replay: same seq
    expect(Object.keys(applyEvent(s, ev(7, 'comment.deleted', { commentId: ids.card3 })).comments)).toEqual([]);
  });

  it('shows pending edits and deletes in the view only', () => {
    const s = withComment();
    const edited = applyPending(s, [{ kind: 'comment.edit', id: ids.card3, body: 'typo fixed' }]);
    expect(edited.comments[ids.card3]?.body).toBe('typo fixed');
    expect(s.comments[ids.card3]?.body).toBe('first draft');
    const deleted = applyPending(s, [{ kind: 'comment.delete', id: ids.card3 }]);
    expect(Object.keys(deleted.comments)).toEqual([]);
    expect(Object.keys(s.comments)).toEqual([ids.card3]);
  });

  it('ignores a pending edit of a comment that is already gone', () => {
    const view = applyPending(base(), [{ kind: 'comment.edit', id: ids.card3, body: 'x' }]);
    expect(Object.keys(view.comments)).toEqual([]);
  });
});

describe('card fields', () => {
  it('fills in the new fields for cards from log entries written before they existed', () => {
    const { dueDate: _d, assigneeIds: _a, labels: _l, ...legacy } = card(ids.card3, ids.colA, 'a2');
    const s = applyEvent(base(), ev(5, 'card.created', { card: legacy as never }));
    expect(s.cards[ids.card3]).toMatchObject({ dueDate: null, assigneeIds: [], labels: [] });
    expect(normalizeCard(legacy as never)).toMatchObject({ dueDate: null, assigneeIds: [], labels: [] });
  });

  it('leaves a complete card untouched', () => {
    const full = card(ids.card1, ids.colA, 'a0', { dueDate: '2026-03-15', labels: ['bug'], assigneeIds: [ids.user] });
    expect(normalizeCard(full)).toBe(full);
  });

  it('shows pending due date, assignee and label changes in the view only', () => {
    const s = base();
    const view = applyPending(s, [
      { kind: 'card.update', id: ids.card1, dueDate: '2026-03-15', assigneeIds: [ids.user], labels: ['bug'] },
    ]);
    expect(view.cards[ids.card1]).toMatchObject({ dueDate: '2026-03-15', assigneeIds: [ids.user], labels: ['bug'] });
    expect(s.cards[ids.card1]).toMatchObject({ dueDate: null, assigneeIds: [], labels: [] });
  });

  it('clears a due date with null, and an empty list clears assignees', () => {
    const s = applyEvent(
      base(),
      ev(5, 'card.updated', {
        card: card(ids.card1, ids.colA, 'a0', { dueDate: '2026-03-15', assigneeIds: [ids.user] }),
      }),
    );
    const view = applyPending(s, [{ kind: 'card.update', id: ids.card1, dueDate: null, assigneeIds: [] }]);
    expect(view.cards[ids.card1]).toMatchObject({ dueDate: null, assigneeIds: [] });
  });
});

describe('cards with comments that were not sent', () => {
  const older = { count: 3, cursor: 'cur-1' };
  const partial = () =>
    stateFromSnapshot({
      board,
      columns: [column(ids.colA, 'a0')],
      cards: [card(ids.card1, ids.colA, 'a0'), card(ids.card2, ids.colA, 'a1')],
      comments: [comment(ids.card3, ids.card1, { body: 'newest' })],
      olderComments: { [ids.card1]: older },
      seq: 10,
    });

  it('starts with no older comments when the snapshot says nothing', () => {
    expect(base().olderComments).toEqual({});
    expect(partial().olderComments).toEqual({ [ids.card1]: older });
  });

  it('ignores an edit to a comment that has not been loaded, so it does not pop up out of order', () => {
    const edited = comment('00000000-0000-4000-8000-0000000000aa', ids.card1, { body: 'old, edited' });
    const s = applyEvent(partial(), ev(11, 'comment.updated', { comment: edited }));
    expect(s.seq).toBe(11);
    expect(Object.keys(s.comments)).toEqual([ids.card3]);
  });

  it('still applies an edit to a loaded comment, and an edit on a card that sent everything', () => {
    const edited = comment(ids.card3, ids.card1, { body: 'newest, edited' });
    expect(applyEvent(partial(), ev(11, 'comment.updated', { comment: edited })).comments[ids.card3]?.body).toBe(
      'newest, edited',
    );
    const other = comment('00000000-0000-4000-8000-0000000000bb', ids.card2, { body: 'x' });
    expect(applyEvent(partial(), ev(11, 'comment.updated', { comment: other })).comments[other.id]).toBeDefined();
  });

  it('drops the record when the card is deleted', () => {
    expect(applyEvent(partial(), ev(11, 'card.deleted', { cardId: ids.card1 })).olderComments).toEqual({});
  });

  it('drops the record when its column is deleted', () => {
    expect(applyEvent(partial(), ev(11, 'column.deleted', { columnId: ids.colA })).olderComments).toEqual({});
  });

  describe('mergeOlderComments', () => {
    const c1 = comment('00000000-0000-4000-8000-000000000101', ids.card1, { body: 'a' });
    const c2 = comment('00000000-0000-4000-8000-000000000102', ids.card1, { body: 'b' });

    it('adds the page and moves the cursor back, counting down what is left', () => {
      const s = mergeOlderComments(partial(), ids.card1, [c1, c2], 'cur-2', 'cur-1');
      expect(Object.keys(s.comments).sort()).toEqual([c1.id, c2.id, ids.card3].sort());
      expect(s.olderComments).toEqual({ [ids.card1]: { count: 1, cursor: 'cur-2' } });
    });

    it('removes the record after the oldest page', () => {
      expect(mergeOlderComments(partial(), ids.card1, [c1], null, 'cur-1').olderComments).toEqual({});
    });

    it('keeps the live version of a comment it already has, and ignores comments of another card', () => {
      const live = comment(ids.card3, ids.card1, { body: 'edited live' });
      const s0 = applyEvent(partial(), ev(11, 'comment.updated', { comment: live }));
      const stale = comment(ids.card3, ids.card1, { body: 'stale' });
      const foreign = comment('00000000-0000-4000-8000-000000000103', ids.card2, { body: 'wrong card' });
      const s = mergeOlderComments(s0, ids.card1, [stale, foreign], null, 'cur-1');
      expect(s.comments[ids.card3]?.body).toBe('edited live');
      expect(s.comments[foreign.id]).toBeUndefined();
    });

    it('does not change the state it was given', () => {
      const s0 = partial();
      mergeOlderComments(s0, ids.card1, [c1], null, 'cur-1');
      expect(s0.olderComments).toEqual({ [ids.card1]: older });
      expect(Object.keys(s0.comments)).toEqual([ids.card3]);
    });
  });
});

describe('comments changing while an older page is being fetched', () => {
  const cursor = 'cur-1';
  const partial = () =>
    stateFromSnapshot({
      board,
      columns: [column(ids.colA, 'a0')],
      cards: [card(ids.card1, ids.colA, 'a0')],
      comments: [comment(ids.card3, ids.card1, { body: 'newest' })],
      olderComments: { [ids.card1]: { count: 2, cursor } },
      seq: 10,
    });
  const X = '00000000-0000-4000-8000-0000000000c1';
  const Y = '00000000-0000-4000-8000-0000000000c2';

  it('does not bring back a comment that was deleted while the page was on its way', () => {
    // The page was read from the database before the delete committed, so it still has X.
    const stalePage = [comment(X, ids.card1, { body: 'doomed' }), comment(Y, ids.card1, { body: 'kept' })];
    const live = applyEvent(partial(), ev(11, 'comment.deleted', { commentId: X }));
    const s = mergeOlderComments(live, ids.card1, stalePage, null, cursor);
    expect(Object.keys(s.comments).sort()).toEqual([Y, ids.card3].sort());
  });

  it('keeps an edit that arrived while the page was on its way, instead of the older text in the page', () => {
    const stalePage = [comment(X, ids.card1, { body: 'before the edit' })];
    const edited = comment(X, ids.card1, { body: 'after the edit', editedAt: '2026-01-02T00:00:00.000Z' });
    const live = applyEvent(partial(), ev(11, 'comment.updated', { comment: edited }));
    const s = mergeOlderComments(live, ids.card1, stalePage, null, cursor);
    expect(s.comments[X]?.body).toBe('after the edit');
  });

  it('uses the latest of several edits, and a later delete beats an earlier edit', () => {
    const v = (body: string) => comment(X, ids.card1, { body });
    let live = applyEvent(partial(), ev(11, 'comment.updated', { comment: v('two') }));
    live = applyEvent(live, ev(12, 'comment.updated', { comment: v('three') }));
    expect(mergeOlderComments(live, ids.card1, [v('one')], null, cursor).comments[X]?.body).toBe('three');
    live = applyEvent(live, ev(13, 'comment.deleted', { commentId: X }));
    expect(mergeOlderComments(live, ids.card1, [v('one')], null, cursor).comments[X]).toBeUndefined();
  });

  it('drops a page that was requested before a new snapshot replaced the cursor', () => {
    const resynced = stateFromSnapshot({
      board,
      columns: [column(ids.colA, 'a0')],
      cards: [card(ids.card1, ids.colA, 'a0')],
      comments: [comment(ids.card3, ids.card1, { body: 'newest' })],
      olderComments: { [ids.card1]: { count: 12, cursor: 'cur-newer' } },
      seq: 20,
    });
    const s = mergeOlderComments(resynced, ids.card1, [comment(X, ids.card1)], null, cursor);
    expect(s).toBe(resynced); // nothing added, and the button for the newer cursor is still there
  });

  it('lowers the count when an unloaded comment is deleted live, if the event says which card it was on', () => {
    const s = applyEvent(partial(), ev(11, 'comment.deleted', { commentId: X, cardId: ids.card1 }));
    expect(s.olderComments[ids.card1]).toMatchObject({ count: 1, cursor });
    // An event for a loaded comment does not touch the count of unloaded ones.
    const loaded = applyEvent(partial(), ev(11, 'comment.deleted', { commentId: ids.card3, cardId: ids.card1 }));
    expect(loaded.olderComments[ids.card1]).toMatchObject({ count: 2 });
  });

  it('leaves the count alone for a delete that does not name its card (older log entries)', () => {
    const s = applyEvent(partial(), ev(11, 'comment.deleted', { commentId: X }));
    expect(s.olderComments[ids.card1]?.count).toBe(2);
  });

  it('does not take a comment off the count twice when its delete arrived before the stale page', () => {
    const stalePage = [comment(X, ids.card1, { body: 'doomed' })];
    const live = applyEvent(partial(), ev(11, 'comment.deleted', { commentId: X, cardId: ids.card1 }));
    // count was 2 (X and one more); X is gone, so one unloaded comment remains after this page.
    const s = mergeOlderComments(live, ids.card1, stalePage, 'cur-2', cursor);
    expect(s.olderComments[ids.card1]?.count).toBe(1);
  });

  it('forgets what it remembered once the card has no older comments left', () => {
    const live = applyEvent(partial(), ev(11, 'comment.deleted', { commentId: X }));
    expect(mergeOlderComments(live, ids.card1, [], null, cursor).olderComments).toEqual({});
  });
});
