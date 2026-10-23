import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const DEV_JWT_SECRET = 'dev-only-change-me';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  /** Shown in the UI and logs so you can see which instance a window is connected to. */
  INSTANCE_ID: z.string().default('server-1'),
  DATABASE_URL: z.string().default('postgres://board:board@localhost:5434/board'),
  REDIS_URL: z.string().default('redis://localhost:6381'),
  /** Postgres connections this instance may hold. Every write holds one for its whole transaction. */
  PG_POOL_MAX: z.coerce.number().int().min(2).max(500).default(10),
  JWT_SECRET: z.string().min(8).default(DEV_JWT_SECRET),
  /** How many reverse proxies sit in front of this server (nginx = 1). 0 ignores X-Forwarded-For. */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  /** Requests per minute, per client IP, across the sign-in routes. */
  AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(20),
  /** Magic links one email address may be sent per hour, so nobody can flood an inbox. */
  MAGIC_LINK_PER_EMAIL_PER_HOUR: z.coerce.number().int().positive().default(5),
  WEB_ORIGIN: z.string().default('http://localhost:5180'),
  /** SMTP connection URL, for example smtp://user:pass@smtp.example.com:587. Unset: emails are printed to the log. */
  SMTP_URL: z
    .string()
    .optional()
    .transform((v) => v || undefined)
    .pipe(z.url().optional()),
  /** The From header of every email the server sends. */
  MAIL_FROM: z.string().min(3).default('Realtime Board <no-reply@localhost>'),
  /** `json`: one JSON object per log line (default in production). `text`: readable lines (default otherwise). */
  LOG_FORMAT: z.enum(['json', 'text']).optional(),
  /** Enables POST /api/auth/dev-login. Off by default in production. */
  AUTH_DEV_LOGIN: bool.optional(),
  /** Seconds a presence entry lives without a heartbeat (crashed clients/instances vanish after this). */
  PRESENCE_TTL_SECONDS: z.coerce.number().int().min(3).default(30),
  /**
   * "Is editing" changes (clicking in and out of fields) re-send the whole roster to the board. At most one such
   * broadcast per board every this many milliseconds; the first goes out at once and the last state always arrives.
   */
  PRESENCE_BROADCAST_MIN_MS: z.coerce.number().int().min(0).default(150),
  /** Board events older than this many days are pruned (the board itself is untouched). 0 keeps everything. */
  EVENT_RETENTION_DAYS: z.coerce.number().int().min(0).default(90),
  /** Whatever their age, each board keeps at least this many of its newest events. Replay and the activity feed need ~500. */
  EVENT_RETENTION_MIN_EVENTS: z.coerce.number().int().min(500).default(1000),
  /** How often each instance tries to prune (one at a time, cluster-wide). 0 never prunes automatically. */
  RETENTION_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(60),
  /** Sustained command rate allowed per socket (events/second) and burst size. */
  RATE_LIMIT_PER_SEC: z.coerce.number().positive().default(20),
  RATE_LIMIT_BURST: z.coerce.number().positive().default(40),
  CURSOR_RATE_PER_SEC: z.coerce.number().positive().default(30),
  /** If a reconnecting client is more than this many events behind, send a snapshot instead of a replay. */
  REPLAY_MAX_EVENTS: z.coerce.number().int().positive().default(500),
});

export type Config = Omit<z.infer<typeof schema>, 'AUTH_DEV_LOGIN' | 'LOG_FORMAT'> & {
  AUTH_DEV_LOGIN: boolean;
  LOG_FORMAT: 'json' | 'text';
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const parsed = schema.parse(env);
  const config = {
    ...parsed,
    AUTH_DEV_LOGIN: parsed.AUTH_DEV_LOGIN ?? parsed.NODE_ENV !== 'production',
    LOG_FORMAT: parsed.LOG_FORMAT ?? (parsed.NODE_ENV === 'production' ? ('json' as const) : ('text' as const)),
    ...overrides,
  };
  // Anyone can read the dev secret in this repo, so tokens signed with it are forgeable.
  if (config.NODE_ENV === 'production' && config.JWT_SECRET === DEV_JWT_SECRET) {
    throw new Error(
      'JWT_SECRET must be set to a private value when NODE_ENV=production (the built-in dev secret is public).',
    );
  }
  return config;
}
