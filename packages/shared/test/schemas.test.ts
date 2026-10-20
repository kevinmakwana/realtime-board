import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  addMemberBody,
  boardEventSchema,
  canWrite,
  clientEventSchemas,
  setRoleBody,
} from '../src/index.js';
import { card, comment, ev, ids } from './fixtures.js';

const uuid = '11111111-1111-4111-8111-111111111111';

describe('client event schemas', () => {
  it('accepts a valid card:move', () => {
    const r = clientEventSchemas['card:move'].safeParse({
      id: uuid,
      boardId: ids.board,
      baseVersion: 3,
      columnId: ids.colB,
      position: 'a0',
    });
    expect(r.success).toBe(true);
  });

  it('rejects non-uuid ids, negative versions and empty positions', () => {
    const r = clientEventSchemas['card:move'].safeParse({
      id: 'nope',
      boardId: ids.board,
      baseVersion: -1,
      columnId: ids.colB,
      position: '',
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path[0])).toEqual(['id', 'baseVersion', 'position']);
  });

  it('rejects an empty card:update and trims titles', () => {
    const base = { id: uuid, boardId: ids.board, baseVersion: 1 };
    expect(clientEventSchemas['card:update'].safeParse(base).success).toBe(false);
    const ok = clientEventSchemas['card:update'].parse({ ...base, title: '  Ship it  ' });
    expect(ok.title).toBe('Ship it');
  });

  it('rejects blank titles and oversized comments', () => {
    expect(
      clientEventSchemas['card:create'].safeParse({
        id: uuid,
        boardId: ids.board,
        columnId: ids.colA,
        title: '   ',
        position: 'a0',
      }).success,
    ).toBe(false);
    expect(
      clientEventSchemas['comment:add'].safeParse({
        id: uuid,
        boardId: ids.board,
        cardId: ids.card1,
        body: 'x'.repeat(2001),
      }).success,
    ).toBe(false);
  });

  it('bounds cursor coordinates to 0..1', () => {
    const s = clientEventSchemas['presence:cursor'];
    expect(s.safeParse({ boardId: ids.board, x: 0.5, y: 1 }).success).toBe(true);
    expect(s.safeParse({ boardId: ids.board, x: 1.2, y: 0 }).success).toBe(false);
  });
});

describe('boardEventSchema', () => {
  it('round-trips a card.created event', () => {
    const e = ev(1, 'card.created', { card: card(ids.card1, ids.colA, 'a0') });
    expect(boardEventSchema.parse(e)).toEqual(e);
  });

  it('rejects unknown event types', () => {
    expect(
      boardEventSchema.safeParse({ ...ev(1, 'card.deleted', { cardId: ids.card1 }), type: 'card.exploded' }).success,
    ).toBe(false);
  });
});

describe('membership schemas', () => {
  it('only lets an owner grant editor or viewer, never owner', () => {
    expect(addMemberBody.safeParse({ email: 'a@example.test', role: 'editor' }).success).toBe(true);
    expect(addMemberBody.safeParse({ email: 'a@example.test', role: 'viewer' }).success).toBe(true);
    expect(addMemberBody.safeParse({ email: 'a@example.test', role: 'owner' }).success).toBe(false);
    expect(setRoleBody.safeParse({ role: 'owner' }).success).toBe(false);
  });

  it('rejects malformed or oversized emails', () => {
    expect(addMemberBody.safeParse({ email: 'not-an-email', role: 'editor' }).success).toBe(false);
    expect(addMemberBody.safeParse({ email: `${'a'.repeat(200)}@example.test`, role: 'editor' }).success).toBe(false);
  });

  it('knows which roles may write', () => {
    expect(canWrite('owner')).toBe(true);
    expect(canWrite('editor')).toBe(true);
    expect(canWrite('viewer')).toBe(false);
    expect(canWrite(null)).toBe(false);
  });

  it('has a FORBIDDEN error code', () => {
    expect(ERROR_CODES).toContain('FORBIDDEN');
  });
});

describe('column:move', () => {
  it('accepts an id, a board and a position key', () => {
    expect(clientEventSchemas['column:move'].safeParse({ id: uuid, boardId: ids.board, position: 'a1' }).success).toBe(
      true,
    );
  });

  it('rejects a missing or empty position and a non-uuid id', () => {
    expect(clientEventSchemas['column:move'].safeParse({ id: uuid, boardId: ids.board }).success).toBe(false);
    expect(clientEventSchemas['column:move'].safeParse({ id: uuid, boardId: ids.board, position: '' }).success).toBe(
      false,
    );
    expect(clientEventSchemas['column:move'].safeParse({ id: 'x', boardId: ids.board, position: 'a1' }).success).toBe(
      false,
    );
  });
});

describe('board:rename', () => {
  const parse = (name: unknown) => clientEventSchemas['board:rename'].safeParse({ boardId: ids.board, name });

  it('accepts a name and trims it', () => {
    const r = parse('  Launch plan  ');
    expect(r.success && r.data.name).toBe('Launch plan');
  });

  it('rejects an empty, blank or over-long name', () => {
    expect(parse('').success).toBe(false);
    expect(parse('   ').success).toBe(false);
    expect(parse('x'.repeat(81)).success).toBe(false);
    expect(parse('x'.repeat(80)).success).toBe(true);
  });

  it('knows the board.renamed event', () => {
    const e = ev(3, 'board.renamed', { name: 'New name' });
    expect(boardEventSchema.safeParse(e).success).toBe(true);
    expect(boardEventSchema.safeParse({ ...e, name: undefined }).success).toBe(false);
  });
});

describe('comment:edit and comment:delete', () => {
  it('edit needs a non-blank body within the limit, trimmed', () => {
    const edit = clientEventSchemas['comment:edit'];
    const r = edit.safeParse({ id: uuid, boardId: ids.board, body: '  fixed  ' });
    expect(r.success && r.data.body).toBe('fixed');
    expect(edit.safeParse({ id: uuid, boardId: ids.board, body: '   ' }).success).toBe(false);
    expect(edit.safeParse({ id: uuid, boardId: ids.board, body: 'x'.repeat(2001) }).success).toBe(false);
    expect(edit.safeParse({ id: uuid, boardId: ids.board, body: 'x'.repeat(2000) }).success).toBe(true);
  });

  it('delete needs only ids', () => {
    expect(clientEventSchemas['comment:delete'].safeParse({ id: uuid, boardId: ids.board }).success).toBe(true);
    expect(clientEventSchemas['comment:delete'].safeParse({ id: 'nope', boardId: ids.board }).success).toBe(false);
  });

  it('knows the comment.updated and comment.deleted events', () => {
    const updated = ev(4, 'comment.updated', { comment: comment(uuid, ids.card1, { editedAt: 'x' }) });
    expect(boardEventSchema.safeParse(updated).success).toBe(true);
    expect(boardEventSchema.safeParse(ev(5, 'comment.deleted', { commentId: uuid })).success).toBe(true);
    expect(
      boardEventSchema.safeParse({ ...ev(5, 'comment.deleted', { commentId: uuid }), commentId: 'x' }).success,
    ).toBe(false);
  });
});

describe('card:update extra fields', () => {
  const update = (extra: Record<string, unknown>) =>
    clientEventSchemas['card:update'].safeParse({ id: uuid, boardId: ids.board, baseVersion: 1, ...extra });

  it('accepts a real due date and null (to clear it), and counts null as a change', () => {
    expect(update({ dueDate: '2026-03-15' }).success).toBe(true);
    expect(update({ dueDate: '2028-02-29' }).success).toBe(true); // leap day
    expect(update({ dueDate: null }).success).toBe(true);
  });

  it('rejects anything that is not a real calendar date', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '15/03/2026', 'tomorrow', '2026-3-5', '2026-03-15T10:00:00Z', '']) {
      expect(update({ dueDate: bad }).success, bad).toBe(false);
    }
  });

  it('accepts member ids and caps how many people can be assigned', () => {
    expect(update({ assigneeIds: [uuid] }).success).toBe(true);
    expect(update({ assigneeIds: [] }).success).toBe(true);
    expect(update({ assigneeIds: ['nope'] }).success).toBe(false);
    expect(
      update({
        assigneeIds: Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
      }).success,
    ).toBe(false);
  });

  it('trims labels and enforces their length and count', () => {
    const ok = update({ labels: ['  bug  ', 'ui'] });
    expect(ok.success && ok.data.labels).toEqual(['bug', 'ui']);
    expect(update({ labels: [''] }).success).toBe(false);
    expect(update({ labels: ['   '] }).success).toBe(false);
    expect(update({ labels: ['x'.repeat(25)] }).success).toBe(false);
    expect(update({ labels: ['x'.repeat(24)] }).success).toBe(true);
    expect(update({ labels: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(true);
    expect(update({ labels: ['a', 'b', 'c', 'd', 'e', 'f'] }).success).toBe(false);
  });

  it('still rejects an update that changes nothing', () => {
    expect(update({}).success).toBe(false);
  });
});
