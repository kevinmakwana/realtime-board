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
  /** Enables POST /api/auth/dev-login. Off by default in production. */
  AUTH_DEV_LOGIN: bool.optional(),
  /** Seconds a presence entry lives without a heartbeat (crashed clients/instances vanish after this). */
  PRESENCE_TTL_SECONDS: z.coerce.number().int().min(3).default(30),
  /** Sustained command rate allowed per socket (events/second) and burst size. */
  RATE_LIMIT_PER_SEC: z.coerce.number().positive().default(20),
  RATE_LIMIT_BURST: z.coerce.number().positive().default(40),
  CURSOR_RATE_PER_SEC: z.coerce.number().positive().default(30),
  /** If a reconnecting client is more than this many events behind, send a snapshot instead of a replay. */
  REPLAY_MAX_EVENTS: z.coerce.number().int().positive().default(500),
});

export type Config = Omit<z.infer<typeof schema>, 'AUTH_DEV_LOGIN'> & { AUTH_DEV_LOGIN: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const parsed = schema.parse(env);
  const config = {
    ...parsed,
    AUTH_DEV_LOGIN: parsed.AUTH_DEV_LOGIN ?? parsed.NODE_ENV !== 'production',
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
