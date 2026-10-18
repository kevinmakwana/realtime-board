import type { Role } from '@board/shared';

/** Anything with pg's `query`: a Pool or a PoolClient inside a transaction. */
export type Db = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

/** The user's role on the board, or null if they are not a member. */
export async function roleOf(db: Db, boardId: string, userId: string): Promise<Role | null> {
  const { rows } = await db.query('SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2', [
    boardId,
    userId,
  ]);
  return (rows[0]?.role as Role | undefined) ?? null;
}
