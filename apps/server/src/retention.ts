import type { Pool } from './db.js';

export interface RetentionOptions {
  /** Events older than this many days may be deleted. 0 switches retention off. */
  days: number;
  /** Whatever their age, the newest this-many events of every board are kept (replay and the activity feed read them). */
  minEvents: number;
  /** Rows deleted per statement, so one pass never holds a long lock or builds a huge transaction. */
  batchSize: number;
}

export interface RetentionResult {
  pruned: number;
  /** True when another instance was already pruning. */
  skipped: boolean;
}

/**
 * Prunes the board event log.
 *
 * The log exists for reconnect catch-up and the activity feed. The board itself is the `columns`, `cards` and
 * `comments` tables, which are always current, so they already are the snapshot: pruning needs no separate
 * snapshot step. A client whose last seen event has been pruned simply gets a fresh snapshot when it rejoins
 * (the gateway replays only a contiguous log), and `boards.last_seq` is untouched, so numbering stays gapless.
 *
 * Every instance can run this; a Postgres advisory lock makes sure only one does at a time.
 */
export class Retention {
  static readonly LOCK_KEY = 7_340_001;

  constructor(
    private readonly pool: Pool,
    private readonly options: RetentionOptions,
  ) {}

  async runOnce(): Promise<RetentionResult> {
    if (this.options.days <= 0) return { pruned: 0, skipped: false };
    // The lock belongs to a connection, so hold one connection for the whole pass.
    const client = await this.pool.connect();
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [Retention.LOCK_KEY]);
      if (!lock.rows[0]?.ok) return { pruned: 0, skipped: true };
      try {
        let pruned = 0;
        for (;;) {
          const batch = await client.query(
            `WITH doomed AS (
               SELECT e.board_id, e.seq
                 FROM board_events e JOIN boards b ON b.id = e.board_id
                WHERE e.created_at < now() - make_interval(days => $1)
                  AND e.seq <= b.last_seq - $2
                LIMIT $3
             )
             DELETE FROM board_events e USING doomed d WHERE e.board_id = d.board_id AND e.seq = d.seq`,
            [this.options.days, this.options.minEvents, this.options.batchSize],
          );
          pruned += batch.rowCount ?? 0;
          if ((batch.rowCount ?? 0) < this.options.batchSize) break;
        }
        return { pruned, skipped: false };
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [Retention.LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }
}
