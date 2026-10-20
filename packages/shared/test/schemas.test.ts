import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  addMemberBody,
  boardEventSchema,
  canWrite,
  clientEventSchemas,
  setRoleBody,
} from '../src/index.js';
import { card, ev, ids } from './fixtures.js';

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
