import { describe, expect, it } from 'vitest';
import { applyEvents, stateFromSnapshot, type BoardSnapshot, type Card, type Comment } from '@board/shared';
import { cardMatches, parseQuery } from '../src/lib/search';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const card = (n: number, extra: Partial<Card> = {}): Card => ({
  id: id(100 + n),
  boardId: id(1),
  columnId: id(10),
  title: `Card ${n}`,
  description: '',
  position: `a${n}`,
  version: 1,
  updatedAt: 'x',
  dueDate: null,
  assigneeIds: [],
  labels: [],
  ...extra,
});
const note = (n: number, cardId: string, body: string): Comment => ({
  id: id(200 + n),
  boardId: id(1),
  cardId,
  authorId: id(2),
  authorName: 'Ada',
  body,
  createdAt: 'x',
  editedAt: null,
});

const snap = (cards: Card[], comments: Comment[] = []): BoardSnapshot => ({
  board: { id: id(1), name: 'B', createdAt: 'x' },
  columns: [{ id: id(10), boardId: id(1), name: 'To do', position: 'a0' }],
  cards,
  comments,
  seq: 0,
});
const names = new Map([[id(2), 'Ada Lovelace']]);

describe('search', () => {
  it('treats an empty or blank query as no filter', () => {
    expect(parseQuery('')).toEqual([]);
    expect(parseQuery('   ')).toEqual([]);
    const s = stateFromSnapshot(snap([card(1)]));
    expect(cardMatches(s, s.cards[card(1).id]!, [], names)).toBe(true);
  });

  it('matches title, description, labels and comments, ignoring case', () => {
    const c = card(1, { title: 'Fix login', description: 'OAuth redirect loop', labels: ['Security'] });
    const s = stateFromSnapshot(snap([c], [note(1, c.id, 'Reproduced on Safari')]));
    const m = (q: string) => cardMatches(s, s.cards[c.id]!, parseQuery(q), names);
    expect(m('LOGIN')).toBe(true);
    expect(m('redirect')).toBe(true);
    expect(m('security')).toBe(true);
    expect(m('safari')).toBe(true);
    expect(m('nothing like this')).toBe(false);
  });

  it('matches assignee names', () => {
    const c = card(1, { assigneeIds: [id(2)] });
    const s = stateFromSnapshot(snap([c]));
    expect(cardMatches(s, s.cards[c.id]!, parseQuery('lovelace'), names)).toBe(true);
    expect(cardMatches(s, s.cards[c.id]!, parseQuery('hopper'), names)).toBe(false);
  });

  it('requires every word, in any order and any field', () => {
    const c = card(1, { title: 'Fix login', labels: ['bug'] });
    const s = stateFromSnapshot(snap([c], [note(1, c.id, 'Safari only')]));
    const m = (q: string) => cardMatches(s, s.cards[c.id]!, parseQuery(q), names);
    expect(m('bug safari login')).toBe(true);
    expect(m('bug chrome')).toBe(false);
  });

  it('does not match comments that belong to other cards', () => {
    const [a, b] = [card(1), card(2)];
    const s = applyEvents(stateFromSnapshot(snap([a, b], [note(1, b.id, 'secret word')])), []);
    expect(cardMatches(s, s.cards[a.id]!, parseQuery('secret'), names)).toBe(false);
    expect(cardMatches(s, s.cards[b.id]!, parseQuery('secret'), names)).toBe(true);
  });
});
