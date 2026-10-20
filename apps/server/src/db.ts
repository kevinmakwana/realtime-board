import pg from 'pg';
import { migrations } from './migrations.js';

export type Pool = pg.Pool;

// A DATE column is a calendar day, not an instant: hand it over as the 'YYYY-MM-DD' text Postgres sends, instead of
// letting the driver turn it into a local-midnight Date that shifts by the server's time zone.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

export function createPool(connectionString: string, max = 10): Pool {
  const pool = new pg.Pool({ connectionString, max });
  // An idle client erroring (e.g. Postgres restart) must not crash the process.
  pool.on('error', () => {});
  return pool;
}

const MIGRATION_LOCK = 727_001;

/** Applies pending migrations. An advisory lock makes concurrent instance start-up safe. */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query<{ id: number }>('SELECT id FROM schema_migrations');
    const done = new Set(rows.map((r) => r.id));
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
