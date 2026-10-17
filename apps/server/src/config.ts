import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3001),
  /** Shown in the UI and logs so you can see which instance a window is connected to. */
  INSTANCE_ID: z.string().default('server-1'),
  DATABASE_URL: z.string().default('postgres://board:board@localhost:5434/board'),
  REDIS_URL: z.string().default('redis://localhost:6381'),
  JWT_SECRET: z.string().min(8).default('dev-only-change-me'),
  WEB_ORIGIN: z.string().default('http://localhost:5180'),
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
  return config;
}
