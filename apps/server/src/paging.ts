import { z } from 'zod';
import { ServiceError } from './errors.js';

/**
 * Keyset cursors: "everything after this row" stays correct while rows are added, which an OFFSET would not.
 * A cursor is opaque to clients: the sort timestamp as Postgres printed it (full microsecond precision, which
 * a JavaScript Date would lose) plus the row id as a tie-breaker, base64url encoded.
 */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

export interface Cursor {
  ts: string;
  id: string;
}

export const encodeCursor = (c: Cursor): string => Buffer.from(`${c.ts}|${c.id}`).toString('base64url');

export function decodeCursor(raw: string): Cursor {
  const [ts, id, ...extra] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (!ts || !id || extra.length > 0 || !TIMESTAMP.test(ts) || !z.uuid().safeParse(id).success) {
    throw new ServiceError('VALIDATION', 'Invalid cursor');
  }
  return { ts, id };
}

/** The `limit` query parameter: a whole number from 1 to `max`. */
export const limitParam = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);

export const cursorParam = z.string().min(1).max(200);
