import type { BoardEvent } from './events.js';
import { normalizeCard } from './models.js';

export interface ActivityEntry {
  seq: number;
  ts: string;
  actorId: string;
  actorName: string;
  /** What happened, without the actor: “renamed the board to …”. */
  text: string;
}

export interface DescribeOptions {
  /** Return only entries with seq >= from; earlier events still teach the titles and names used in the text. */
  from?: number;
  /**
   * Columns that exist without a `column.created` event (a new board's defaults are seeded, not logged).
   * Later events override these, so a column renamed since is still described as it was at the time.
   */
  knownColumns?: { id: string; name: string; position: string }[];
}

const q = (s: string) => `“${s}”`;
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Turns the event log into readable lines. The log says "card deleted" with only an id, so this walks the events
 * in order and remembers the titles and column names it has seen. When the window starts mid-history it falls
 * back to plain wording ("deleted a card") rather than guessing.
 */
export function describeActivity(
  events: BoardEvent[],
  nameOf: (userId: string) => string | undefined,
  { from = 0, knownColumns = [] }: DescribeOptions = {},
): ActivityEntry[] {
  const columns = new Map<string, { name: string; position: string }>(
    knownColumns.map((c) => [c.id, { name: c.name, position: c.position }]),
  );
  const cards = new Map<string, ReturnType<typeof normalizeCard>>();
  const commentCard = new Map<string, string>();
  const out: ActivityEntry[] = [];

  const titleOf = (cardId: string) => cards.get(cardId)?.title;
  const onCard = (cardId: string) => {
    const title = titleOf(cardId);
    return title === undefined ? '' : ` on ${q(title)}`;
  };

  for (const e of events) {
    let text: string;
    switch (e.type) {
      case 'board.renamed':
        text = `renamed the board to ${q(e.name)}`;
        break;
      case 'column.created':
        columns.set(e.column.id, { name: e.column.name, position: e.column.position });
        text = `added column ${q(e.column.name)}`;
        break;
      case 'column.updated': {
        const before = columns.get(e.column.id);
        columns.set(e.column.id, { name: e.column.name, position: e.column.position });
        text =
          before && before.name !== e.column.name
            ? `renamed column ${q(before.name)} to ${q(e.column.name)}`
            : `moved column ${q(e.column.name)}`;
        break;
      }
      case 'column.deleted': {
        const gone = columns.get(e.columnId);
        columns.delete(e.columnId);
        for (const [id, c] of cards) if (c.columnId === e.columnId) cards.delete(id);
        text = gone ? `deleted column ${q(gone.name)}` : 'deleted a column';
        break;
      }
      case 'card.created': {
        const card = normalizeCard(e.card);
        cards.set(card.id, card);
        const col = columns.get(card.columnId);
        text = `added card ${q(card.title)}${col ? ` to ${q(col.name)}` : ''}`;
        break;
      }
      case 'card.moved': {
        const before = cards.get(e.card.id);
        const card = normalizeCard(e.card);
        cards.set(card.id, card);
        const fromCol = before && columns.get(before.columnId);
        const toCol = columns.get(card.columnId);
        if (before && before.columnId === card.columnId) text = `reordered ${q(card.title)}`;
        else if (fromCol && toCol) text = `moved ${q(card.title)} from ${q(fromCol.name)} to ${q(toCol.name)}`;
        else if (toCol) text = `moved ${q(card.title)} to ${q(toCol.name)}`;
        else text = `moved ${q(card.title)}`;
        break;
      }
      case 'card.updated': {
        const before = cards.get(e.card.id);
        const card = normalizeCard(e.card);
        cards.set(card.id, card);
        const changes: string[] = [];
        if (before) {
          if (before.title !== card.title) changes.push(`renamed it from ${q(before.title)}`);
          if (before.description !== card.description) changes.push('edited the description');
          if (before.dueDate !== card.dueDate)
            changes.push(card.dueDate ? `set the due date to ${card.dueDate}` : 'cleared the due date');
          if (!sameSet(before.labels, card.labels)) changes.push('changed the labels');
          if (!sameSet(before.assigneeIds, card.assigneeIds)) changes.push('changed the assignees');
        }
        text = `updated ${q(card.title)}${changes.length ? `: ${changes.join(', ')}` : ''}`;
        break;
      }
      case 'card.deleted': {
        const title = titleOf(e.cardId);
        cards.delete(e.cardId);
        text = title === undefined ? 'deleted a card' : `deleted card ${q(title)}`;
        break;
      }
      case 'comment.added':
        commentCard.set(e.comment.id, e.comment.cardId);
        text = `commented${onCard(e.comment.cardId)}`;
        break;
      case 'comment.updated':
        commentCard.set(e.comment.id, e.comment.cardId);
        text = `edited a comment${onCard(e.comment.cardId)}`;
        break;
      case 'comment.deleted': {
        const cardId = commentCard.get(e.commentId);
        commentCard.delete(e.commentId);
        text = `deleted a comment${cardId ? onCard(cardId) : ''}`;
        break;
      }
    }
    if (e.seq >= from) {
      out.push({ seq: e.seq, ts: e.ts, actorId: e.actorId, actorName: nameOf(e.actorId) ?? 'Someone', text });
    }
  }
  return out;
}
