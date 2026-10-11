import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { Redis } from 'ioredis';

/** Runs once before the integration project: checks infra is reachable and the schema is current. */
export default async function setup() {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL, 2);
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    await migrate(pool);
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(
      `Integration tests need Postgres and Redis.\n  DATABASE_URL=${config.DATABASE_URL}\n  REDIS_URL=${config.REDIS_URL}\n` +
        `Start them with \`npm run infra:up\`.\n${String(err)}`,
    );
  } finally {
    redis.disconnect();
    await pool.end();
  }
}
