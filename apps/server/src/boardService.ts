import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  isValidOrderKey,
  keysBetween,
  resolveCollision,
  type Board,
  type BoardWithRole,
  type BoardEvent,
  type BoardSnapshot,
  type Card,
  type ClientEventPayload,
  type Column,
  type Comment,
  type NewBoardEvent,
  type Role,
  canWrite,
} from '@board/shared';
import type { Pool } from './db.js';
import { ServiceError } from './errors.js';
import { roleOf } from './roles.js';

/* ---------- row mappers ---------- */

type Row = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

const toBoard = (r: Row): Board => ({ id: r.id as string, name: r.name as string, createdAt: iso(r.created_at) });
const toColumn = (r: Row): Column => ({
  id: r.id as string,
  boardId: r.board_id as string,
  name: r.name as string,
  position: r.position as string,
});
const toCard = (r: Row): Card => ({
  id: r.id as string,
  boardId: r.board_id as string,
  columnId: r.column_id as string,
  title: r.title as string,
  description: r.description as string,
  position: r.position as string,
  version: r.version as number,
  updatedAt: iso(r.updated_at),
});
const toComment = (r: Row): Comment => ({
  id: r.id as string,
  boardId: r.board_id as string,
  cardId: r.card_id as string,
  authorId: r.author_id as string,
  authorName: r.author_name as string,
  body: r.body as string,
  createdAt: iso(r.created_at),
});

const DEFAULT_COLUMNS = ['To do', 'In progress', 'Done'];

/** Result of a command: the event it produced (null when it was an idempotent no-op) and the board's seq. */
export interface CommitResult {
  event: BoardEvent | null;
  seq: number;
  version?: number;
}

type Tx = pg.PoolClient;
type EventBody = NewBoardEvent;

export class BoardService {
  constructor(private readonly pool: Pool) {}

  /* ---------------- reads ---------------- */

  async listBoards(userId: string): Promise<BoardWithRole[]> {
    const { rows } = await this.pool.query(
      `SELECT b.id, b.name, b.created_at, m.role
         FROM boards b JOIN board_members m ON m.board_id = b.id
        WHERE m.user_id = $1 ORDER BY b.created_at DESC LIMIT 100`,
      [userId],
    );
    return rows.map((r) => ({ ...toBoard(r), role: r.role as Role }));
  }

  async role(boardId: string, userId: string): Promise<Role | null> {
    return roleOf(this.pool, boardId, userId);
  }

  async boardExists(boardId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM boards WHERE id = $1', [boardId]);
    return (rowCount ?? 0) > 0;
  }

  async latestSeq(boardId: string): Promise<number | null> {
    const { rows } = await this.pool.query('SELECT last_seq FROM boards WHERE id = $1', [boardId]);
    return rows[0] ? (rows[0].last_seq as number) : null;
  }

  /** Consistent snapshot: rows and `seq` come from a single repeatable-read transaction. */
  async getSnapshot(boardId: string): Promise<BoardSnapshot | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const b = await client.query('SELECT id, name, created_at, last_seq FROM boards WHERE id = $1', [boardId]);
      const boardRow = b.rows[0];
      if (!boardRow) {
        // End the transaction before the connection goes back to the pool, or it is handed out read-only.
        await client.query('ROLLBACK');
        return null;
      }
      // Sequential on purpose: a pg client runs one query at a time.
      const cols = await client.query('SELECT * FROM columns WHERE board_id = $1 ORDER BY position, id', [boardId]);
      const cards = await client.query('SELECT * FROM cards WHERE board_id = $1 ORDER BY position, id', [boardId]);
      const comments = await client.query(
        `SELECT c.*, u.name AS author_name FROM comments c JOIN users u ON u.id = c.author_id
         WHERE c.board_id = $1 ORDER BY c.created_at, c.id`,
        [boardId],
      );
      await client.query('COMMIT');
      return {
        board: toBoard(boardRow),
        columns: cols.rows.map(toColumn),
        cards: cards.rows.map(toCard),
        comments: comments.rows.map(toComment),
        seq: boardRow.last_seq as number,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Events with seq > `after`, oldest first. */
  async eventsSince(boardId: string, after: number, limit = 1000): Promise<BoardEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT seq, type, payload, actor_id, created_at FROM board_events
       WHERE board_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [boardId, after, limit],
    );
    return rows.map(
      (r) =>
        ({
          ...(r.payload as object),
          seq: r.seq as number,
          type: r.type as BoardEvent['type'],
          boardId,
          actorId: r.actor_id as string,
          ts: iso(r.created_at),
        }) as BoardEvent,
    );
  }

  /* ---------------- boards (REST, no events: nobody is subscribed yet) ---------------- */

  async createBoard(ownerId: string, name: string): Promise<BoardSnapshot> {
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO boards (id, name, owner_id) VALUES ($1, $2, $3)', [id, name, ownerId]);
      await client.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'owner')", [id, ownerId]);
      const positions = keysBetween(null, null, DEFAULT_COLUMNS.length);
      for (const [i, colName] of DEFAULT_COLUMNS.entries()) {
        await client.query('INSERT INTO columns (id, board_id, name, position) VALUES ($1, $2, $3, $4)', [
          randomUUID(),
          id,
          colName,
          positions[i],
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return (await this.getSnapshot(id))!;
  }

  /* ---------------- commands ---------------- */

  /**
   * Runs `fn` inside a transaction that holds the board row lock. The lock serialises writers per
   * board, so `last_seq + 1` is gapless and commit order == seq order. The event row is written in
   * the same transaction as the change: a crash can never leave one without the other.
   */
  private async commit(
    boardId: string,
    actorId: string,
    fn: (tx: Tx) => Promise<{ body: EventBody; version?: number } | null>,
    opts: { ownerOnly?: boolean } = {},
  ): Promise<CommitResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query('SELECT last_seq FROM boards WHERE id = $1 FOR UPDATE', [boardId]);
      if (!lock.rows[0]) throw new ServiceError('NOT_FOUND', 'Board not found');
      const current = lock.rows[0].last_seq as number;
      // Read inside the lock: a removal committed before this point is always seen.
      const role = await roleOf(client, boardId, actorId);
      if (!role) throw new ServiceError('NOT_FOUND', 'Board not found');
      if (!canWrite(role)) throw new ServiceError('FORBIDDEN', 'You have view-only access to this board');
      if (opts.ownerOnly && role !== 'owner') throw new ServiceError('FORBIDDEN', 'Only the board owner can do that');

      const out = await fn(client);
      if (!out) {
        await client.query('COMMIT');
        return { event: null, seq: current };
      }

      const seq = current + 1;
      const { type, boardId: _b, actorId: _a, ...payload } = out.body as EventBody & Record<string, unknown>;
      await client.query('UPDATE boards SET last_seq = $2 WHERE id = $1', [boardId, seq]);
      const ins = await client.query(
        'INSERT INTO board_events (board_id, seq, type, payload, actor_id) VALUES ($1, $2, $3, $4, $5) RETURNING created_at',
        [boardId, seq, type, JSON.stringify(payload), actorId],
      );
      await client.query('COMMIT');
      const event = { ...out.body, seq, ts: iso(ins.rows[0].created_at) } as BoardEvent;
      return { event, seq, version: out.version };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Owner only. Renaming to the current name writes nothing. */
  async renameBoard(actorId: string, p: ClientEventPayload<'board:rename'>): Promise<CommitResult> {
    return this.commit(
      p.boardId,
      actorId,
      async (tx) => {
        const { rows } = await tx.query('SELECT name FROM boards WHERE id = $1', [p.boardId]);
        if (rows[0]?.name === p.name) return null;
        await tx.query('UPDATE boards SET name = $2 WHERE id = $1', [p.boardId, p.name]);
        return { body: { type: 'board.renamed', boardId: p.boardId, actorId, name: p.name } };
      },
      { ownerOnly: true },
    );
  }

  async createColumn(actorId: string, p: ClientEventPayload<'column:create'>): Promise<CommitResult> {
    if (!isValidOrderKey(p.position)) throw new ServiceError('VALIDATION', 'Invalid position key');
    return this.commit(p.boardId, actorId, async (tx) => {
      if (await this.isRetry(tx, 'columns', p.id, p.boardId)) return null; // idempotent retry
      const sibs = await tx.query('SELECT id, position FROM columns WHERE board_id = $1', [p.boardId]);
      const position = resolveCollision(p.position, sibs.rows as { id: string; position: string }[]);
      const { rows } = await tx.query(
        'INSERT INTO columns (id, board_id, name, position) VALUES ($1, $2, $3, $4) RETURNING *',
        [p.id, p.boardId, p.name, position],
      );
      return { body: { type: 'column.created', boardId: p.boardId, actorId, column: toColumn(rows[0]) } };
    });
  }

  async renameColumn(actorId: string, p: ClientEventPayload<'column:rename'>): Promise<CommitResult> {
    return this.commit(p.boardId, actorId, async (tx) => {
      const { rows } = await tx.query('UPDATE columns SET name = $3 WHERE id = $1 AND board_id = $2 RETURNING *', [
        p.id,
        p.boardId,
        p.name,
      ]);
      if (!rows[0]) throw new ServiceError('NOT_FOUND', 'Column not found');
      return { body: { type: 'column.updated', boardId: p.boardId, actorId, column: toColumn(rows[0]) } };
    });
  }

  /** Reorder. A drop into a gap someone else just took gets a fresh key next to it, never a duplicate. */
  async moveColumn(actorId: string, p: ClientEventPayload<'column:move'>): Promise<CommitResult> {
    if (!isValidOrderKey(p.position)) throw new ServiceError('VALIDATION', 'Invalid position key');
    return this.commit(p.boardId, actorId, async (tx) => {
      const current = await tx.query('SELECT position FROM columns WHERE id = $1 AND board_id = $2 FOR UPDATE', [
        p.id,
        p.boardId,
      ]);
      if (!current.rows[0]) throw new ServiceError('NOT_FOUND', 'Column not found');
      const sibs = await tx.query('SELECT id, position FROM columns WHERE board_id = $1 AND id <> $2', [
        p.boardId,
        p.id,
      ]);
      const position = resolveCollision(p.position, sibs.rows as { id: string; position: string }[]);
      if (position === current.rows[0].position) return null; // already there
      const { rows } = await tx.query('UPDATE columns SET position = $3 WHERE id = $1 AND board_id = $2 RETURNING *', [
        p.id,
        p.boardId,
        position,
      ]);
      return { body: { type: 'column.updated', boardId: p.boardId, actorId, column: toColumn(rows[0]) } };
    });
  }

  async deleteColumn(actorId: string, p: ClientEventPayload<'column:delete'>): Promise<CommitResult> {
    return this.commit(p.boardId, actorId, async (tx) => {
      const { rowCount } = await tx.query('DELETE FROM columns WHERE id = $1 AND board_id = $2', [p.id, p.boardId]);
      if (!rowCount) throw new ServiceError('NOT_FOUND', 'Column not found');
      return { body: { type: 'column.deleted', boardId: p.boardId, actorId, columnId: p.id } };
    });
  }

  async createCard(actorId: string, p: ClientEventPayload<'card:create'>): Promise<CommitResult> {
    if (!isValidOrderKey(p.position)) throw new ServiceError('VALIDATION', 'Invalid position key');
    return this.commit(p.boardId, actorId, async (tx) => {
      if (await this.isRetry(tx, 'cards', p.id, p.boardId)) return null; // idempotent retry
      const col = await tx.query('SELECT 1 FROM columns WHERE id = $1 AND board_id = $2', [p.columnId, p.boardId]);
      if (!col.rowCount) throw new ServiceError('NOT_FOUND', 'Column not found');
      const position = await this.freePosition(tx, p.columnId, p.position, null);
      const { rows } = await tx.query(
        'INSERT INTO cards (id, board_id, column_id, title, position) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [p.id, p.boardId, p.columnId, p.title, position],
      );
      const card = toCard(rows[0]);
      return { body: { type: 'card.created', boardId: p.boardId, actorId, card }, version: card.version };
    });
  }

  async updateCard(actorId: string, p: ClientEventPayload<'card:update'>): Promise<CommitResult> {
    return this.commit(p.boardId, actorId, async (tx) => {
      const current = await this.lockCard(tx, p.id, p.boardId, p.baseVersion);
      const { rows } = await tx.query(
        `UPDATE cards SET title = COALESCE($2, title), description = COALESCE($3, description),
                version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [current.id, p.title ?? null, p.description ?? null],
      );
      const card = toCard(rows[0]);
      return { body: { type: 'card.updated', boardId: p.boardId, actorId, card }, version: card.version };
    });
  }

  async moveCard(actorId: string, p: ClientEventPayload<'card:move'>): Promise<CommitResult> {
    if (!isValidOrderKey(p.position)) throw new ServiceError('VALIDATION', 'Invalid position key');
    return this.commit(p.boardId, actorId, async (tx) => {
      const current = await this.lockCard(tx, p.id, p.boardId, p.baseVersion);
      const col = await tx.query('SELECT 1 FROM columns WHERE id = $1 AND board_id = $2', [p.columnId, p.boardId]);
      if (!col.rowCount) throw new ServiceError('NOT_FOUND', 'Column not found');
      const position = await this.freePosition(tx, p.columnId, p.position, current.id);
      const { rows } = await tx.query(
        'UPDATE cards SET column_id = $2, position = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *',
        [current.id, p.columnId, position],
      );
      const card = toCard(rows[0]);
      return { body: { type: 'card.moved', boardId: p.boardId, actorId, card }, version: card.version };
    });
  }

  async deleteCard(actorId: string, p: ClientEventPayload<'card:delete'>): Promise<CommitResult> {
    return this.commit(p.boardId, actorId, async (tx) => {
      const current = await this.lockCard(tx, p.id, p.boardId, p.baseVersion);
      await tx.query('DELETE FROM cards WHERE id = $1', [current.id]);
      return { body: { type: 'card.deleted', boardId: p.boardId, actorId, cardId: current.id } };
    });
  }

  async addComment(actorId: string, p: ClientEventPayload<'comment:add'>): Promise<CommitResult> {
    return this.commit(p.boardId, actorId, async (tx) => {
      if (await this.isRetry(tx, 'comments', p.id, p.boardId)) return null; // idempotent retry
      const card = await tx.query('SELECT 1 FROM cards WHERE id = $1 AND board_id = $2', [p.cardId, p.boardId]);
      if (!card.rowCount) throw new ServiceError('NOT_FOUND', 'Card not found');
      const { rows } = await tx.query(
        `WITH ins AS (
           INSERT INTO comments (id, board_id, card_id, author_id, body) VALUES ($1, $2, $3, $4, $5) RETURNING *
         ) SELECT ins.*, u.name AS author_name FROM ins JOIN users u ON u.id = ins.author_id`,
        [p.id, p.boardId, p.cardId, actorId, p.body],
      );
      return { body: { type: 'comment.added', boardId: p.boardId, actorId, comment: toComment(rows[0]) } };
    });
  }

  /* ---------------- helpers ---------------- */

  /**
   * Client-generated ids make create commands safe to retry: seeing the id again on the same board
   * means the earlier attempt landed, so the retry is a no-op. The same id on a *different* board
   * is not a retry, so it is refused instead of being reported as a success that never happened.
   */
  private async isRetry(
    tx: Tx,
    table: 'columns' | 'cards' | 'comments',
    id: string,
    boardId: string,
  ): Promise<boolean> {
    const { rows } = await tx.query(`SELECT board_id FROM ${table} WHERE id = $1`, [id]);
    if (!rows[0]) return false;
    if (rows[0].board_id !== boardId) throw new ServiceError('VALIDATION', 'That id is already in use');
    return true;
  }

  /**
   * Version check (last-writer-wins, but only against the version the client actually saw).
   * A stale edit is rejected and the current card is returned so the client can resync.
   */
  private async lockCard(tx: Tx, id: string, boardId: string, baseVersion: number): Promise<Card> {
    const { rows } = await tx.query('SELECT * FROM cards WHERE id = $1 AND board_id = $2 FOR UPDATE', [id, boardId]);
    if (!rows[0]) throw new ServiceError('NOT_FOUND', 'Card not found');
    const card = toCard(rows[0]);
    if (card.version !== baseVersion) {
      throw new ServiceError(
        'VERSION_CONFLICT',
        `Card changed since you last saw it (yours: v${baseVersion}, current: v${card.version})`,
        card,
      );
    }
    return card;
  }

  /** The desired fractional key, or a fresh one next to it if another card already sits there. */
  private async freePosition(tx: Tx, columnId: string, desired: string, excludeCardId: string | null): Promise<string> {
    const { rows } = await tx.query('SELECT id, position FROM cards WHERE column_id = $1 AND id <> $2', [
      columnId,
      excludeCardId ?? randomUUID(),
    ]);
    return resolveCollision(desired, rows as { id: string; position: string }[]);
  }
}
