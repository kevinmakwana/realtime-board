import { describe, expect, it } from 'vitest';
import { cardMoveTarget, columnMoveTarget } from '../src/lib/moves';
import { COL_DONE, COL_TODO, makeCard, makeState } from './componentHelpers';

// To do: Card 1, Card 2, Card 3.  Done: Card 4.
const cards = [makeCard(1), makeCard(2), makeCard(3), makeCard(4, { columnId: COL_DONE, position: 'a0' })];
const state = makeState(cards);
const id = (n: number) => makeCard(n).id;

describe('cardMoveTarget', () => {
  it('moves a card up and down within its column, counting the other cards', () => {
    expect(cardMoveTarget(state, id(2), 'up')).toMatchObject({ columnId: COL_TODO, index: 0, position: 1, total: 3 });
    expect(cardMoveTarget(state, id(2), 'down')).toMatchObject({ columnId: COL_TODO, index: 2, position: 3 });
  });

  it('has nowhere to go past the top or bottom of the column', () => {
    expect(cardMoveTarget(state, id(1), 'up')).toBeNull();
    expect(cardMoveTarget(state, id(3), 'down')).toBeNull();
  });

  it('moves to the neighbouring column, keeping the row where it fits and landing last otherwise', () => {
    expect(cardMoveTarget(state, id(1), 'right')).toMatchObject({
      columnId: COL_DONE,
      index: 0,
      position: 1,
      total: 2,
    });
    expect(cardMoveTarget(state, id(3), 'right')).toMatchObject({
      columnId: COL_DONE,
      index: 1,
      position: 2,
      total: 2,
    });
    expect(cardMoveTarget(state, id(4), 'left')).toMatchObject({ columnId: COL_TODO, index: 0, position: 1, total: 4 });
  });

  it('has no neighbour beyond the first and last column', () => {
    expect(cardMoveTarget(state, id(1), 'left')).toBeNull();
    expect(cardMoveTarget(state, id(4), 'right')).toBeNull();
  });

  it('knows nothing about a card that is not there', () => {
    expect(cardMoveTarget(state, 'missing', 'up')).toBeNull();
  });

  it('names the destination for a screen reader', () => {
    expect(cardMoveTarget(state, id(1), 'right')?.message).toBe('Moved “Card 1” to Done, position 1 of 2');
  });
});

describe('columnMoveTarget', () => {
  it('moves a column one place and stops at the ends', () => {
    expect(columnMoveTarget(state, COL_TODO, 'right')).toMatchObject({
      index: 1,
      message: 'Moved column “To do” to position 2 of 2',
    });
    expect(columnMoveTarget(state, COL_DONE, 'left')).toMatchObject({ index: 0 });
    expect(columnMoveTarget(state, COL_TODO, 'left')).toBeNull();
    expect(columnMoveTarget(state, COL_DONE, 'right')).toBeNull();
  });
});
