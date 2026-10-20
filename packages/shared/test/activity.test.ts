import { describe, expect, it } from 'vitest';
import { describeActivity } from '../src/index.js';
import { card, column, comment, ev, ids } from './fixtures.js';

const names: Record<string, string> = { [ids.user]: 'Ada' };
const nameOf = (id: string) => names[id];
const lines = (events: ReturnType<typeof ev>[]) => describeActivity(events, nameOf).map((e) => e.text);

describe('describeActivity', () => {
  it('names the actor and falls back for someone unknown', () => {
    const [entry] = describeActivity([ev(1, 'board.renamed', { name: 'Q4' })], nameOf);
    expect(entry).toMatchObject({ seq: 1, actorId: ids.user, actorName: 'Ada', text: 'renamed the board to “Q4”' });
    const [stranger] = describeActivity([ev(1, 'board.renamed', { name: 'Q4' })], () => undefined);
    expect(stranger?.actorName).toBe('Someone');
  });

  it('describes card lifecycle with titles and column names it learned from earlier events', () => {
    const todo = column(ids.colA, 'a0', 'To do');
    const done = column(ids.colB, 'a1', 'Done');
    const c = card(ids.card1, ids.colA, 'a0', { title: 'Ship it' });
    expect(
      lines([
        ev(1, 'column.created', { column: todo }),
        ev(2, 'column.created', { column: done }),
        ev(3, 'card.created', { card: c }),
        ev(4, 'card.moved', { card: { ...c, columnId: ids.colB, version: 2 } }),
        ev(5, 'card.deleted', { cardId: ids.card1 }),
      ]),
    ).toEqual([
      'added column “To do”',
      'added column “Done”',
      'added card “Ship it” to “To do”',
      'moved “Ship it” from “To do” to “Done”',
      'deleted card “Ship it”',
    ]);
  });

  it('tells a column rename from a column move, and a delete from the title it had', () => {
    expect(
      lines([
        ev(1, 'column.created', { column: column(ids.colA, 'a0', 'Todo') }),
        ev(2, 'column.updated', { column: column(ids.colA, 'a0', 'Backlog') }),
        ev(3, 'column.updated', { column: column(ids.colA, 'a5', 'Backlog') }),
        ev(4, 'column.deleted', { columnId: ids.colA }),
      ]),
    ).toEqual([
      'added column “Todo”',
      'renamed column “Todo” to “Backlog”',
      'moved column “Backlog”',
      'deleted column “Backlog”',
    ]);
  });

  it('lists what changed on a card update', () => {
    const base = card(ids.card1, ids.colA, 'a0', { title: 'Task' });
    const next = {
      ...base,
      title: 'Task v2',
      description: 'now with detail',
      dueDate: '2026-03-15',
      labels: ['bug'],
      assigneeIds: [ids.user],
      version: 2,
    };
    expect(lines([ev(1, 'card.created', { card: base }), ev(2, 'card.updated', { card: next })])[1]).toBe(
      'updated “Task v2”: renamed it from “Task”, edited the description, set the due date to 2026-03-15, changed the labels, changed the assignees',
    );
    expect(
      lines([
        ev(1, 'card.created', { card: next }),
        ev(2, 'card.updated', { card: { ...next, dueDate: null, version: 3 } }),
      ])[1],
    ).toBe('updated “Task v2”: cleared the due date');
  });

  it('describes comments by the card they are on', () => {
    const c = card(ids.card1, ids.colA, 'a0', { title: 'Task' });
    const note = comment(ids.card2, ids.card1);
    expect(
      lines([
        ev(1, 'card.created', { card: c }),
        ev(2, 'comment.added', { comment: note }),
        ev(3, 'comment.updated', { comment: { ...note, body: 'x', editedAt: 'now' } }),
        ev(4, 'comment.deleted', { commentId: ids.card2 }),
      ]).slice(1),
    ).toEqual(['commented on “Task”', 'edited a comment on “Task”', 'deleted a comment on “Task”']);
  });

  it('degrades gracefully when the log window starts mid-history', () => {
    expect(lines([ev(9, 'card.deleted', { cardId: ids.card1 })])).toEqual(['deleted a card']);
    expect(lines([ev(9, 'comment.deleted', { commentId: ids.card2 })])).toEqual(['deleted a comment']);
    const c = card(ids.card1, ids.colA, 'a0', { title: 'Task' });
    expect(lines([ev(9, 'card.updated', { card: c })])).toEqual(['updated “Task”']);
    expect(lines([ev(9, 'card.moved', { card: c })])).toEqual(['moved “Task”']);
  });

  it('copes with log entries written before the card fields existed', () => {
    const { dueDate: _d, assigneeIds: _a, labels: _l, ...legacy } = card(ids.card1, ids.colA, 'a0', { title: 'Old' });
    expect(() =>
      lines([ev(1, 'card.created', { card: legacy as never }), ev(2, 'card.updated', { card: legacy as never })]),
    ).not.toThrow();
  });

  it('uses columns it was told about for boards whose default columns were never logged', () => {
    const c = card(ids.card1, ids.colA, 'a0', { title: 'Task' });
    const out = describeActivity([ev(1, 'card.created', { card: c })], nameOf, {
      knownColumns: [{ id: ids.colA, name: 'To do', position: 'a0' }],
    });
    expect(out[0]?.text).toBe('added card “Task” to “To do”');
  });

  it('only returns the entries asked for when given a lookback', () => {
    const c = card(ids.card1, ids.colA, 'a0', { title: 'Task' });
    const all = [ev(1, 'card.created', { card: c }), ev(2, 'card.deleted', { cardId: ids.card1 })];
    expect(describeActivity(all, nameOf, { from: 2 }).map((e) => e.text)).toEqual(['deleted card “Task”']);
  });
});
