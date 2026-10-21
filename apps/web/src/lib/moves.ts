import { selectCards, selectColumns, type BoardState } from '@board/shared';

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface CardMove {
  columnId: string;
  /** Where the card goes among the column's other cards: what `BoardClient.moveCard` takes. */
  index: number;
  /** 1-based place in the column after the move, and how many cards it will hold, for announcing. */
  position: number;
  total: number;
  message: string;
}

/** Where a card would land if moved one step with the keyboard, or null at the edge of the board. */
export function cardMoveTarget(state: BoardState, cardId: string, dir: Direction): CardMove | null {
  const card = state.cards[cardId];
  if (!card) return null;
  const columns = selectColumns(state);
  const here = selectCards(state, card.columnId);
  const row = here.findIndex((c) => c.id === cardId);

  let columnId = card.columnId;
  let index: number;
  let total = here.length;
  if (dir === 'up' || dir === 'down') {
    index = dir === 'up' ? row - 1 : row + 1;
    if (index < 0 || index >= here.length) return null;
  } else {
    const col = columns.findIndex((c) => c.id === card.columnId);
    const next = columns[dir === 'left' ? col - 1 : col + 1];
    if (!next) return null;
    columnId = next.id;
    total = selectCards(state, next.id).length + 1;
    index = Math.min(row, total - 1);
  }
  const place = index + 1;
  const where = state.columns[columnId]?.name ?? 'column';
  return {
    columnId,
    index,
    position: place,
    total,
    message: `Moved “${card.title}” to ${where}, position ${place} of ${total}`,
  };
}

export interface ColumnMove {
  /** Index among the other columns: what `BoardClient.moveColumn` takes. */
  index: number;
  message: string;
}

export function columnMoveTarget(state: BoardState, columnId: string, dir: 'left' | 'right'): ColumnMove | null {
  const columns = selectColumns(state);
  const from = columns.findIndex((c) => c.id === columnId);
  if (from === -1) return null;
  const to = dir === 'left' ? from - 1 : from + 1;
  if (to < 0 || to >= columns.length) return null;
  return { index: to, message: `Moved column “${columns[from]?.name}” to position ${to + 1} of ${columns.length}` };
}
