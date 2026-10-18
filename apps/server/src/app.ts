import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { LIMITS } from '@board/shared';
import type { Redis } from 'ioredis';
import { consumeMagicToken, createMagicLink, signToken, upsertUser, verifyToken } from './auth.js';
import type { BoardService } from './boardService.js';
import type { Config } from './config.js';
import type { Pool } from './db.js';
import { redisRateLimit } from './httpRateLimit.js';
import type { Logger } from './logger.js';

interface Deps {
  config: Config;
  pool: Pool;
  redis: Redis;
  service: BoardService;
  log: Logger;
}

const emailSchema = z.object({ email: z.email().max(200), name: z.string().trim().min(1).max(60).optional() });

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApp({ config, pool, redis, service, log }: Deps) {
  const app = express();
  app.disable('x-powered-by');
  // Without this, req.ip is the proxy's address and every client would share one rate-limit budget.
  app.set('trust proxy', config.TRUST_PROXY);
  app.use(helmet());
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, instance: config.INSTANCE_ID });
  });

  /* ---------- auth ---------- */

  const api = express.Router();

  // Sign-in routes are unauthenticated, so they are the ones worth brute-forcing or spamming.
  api.use(
    '/auth',
    redisRateLimit(redis, {
      name: 'auth',
      limit: config.AUTH_RATE_LIMIT_PER_MIN,
      windowSeconds: 60,
      key: (req) => req.ip ?? 'unknown',
      log,
    }),
  );

  // Dev login: any email gets a JWT. Disabled in production unless explicitly enabled.
  api.post('/auth/dev-login', async (req, res) => {
    if (!config.AUTH_DEV_LOGIN) throw new HttpError(404, 'Dev login is disabled');
    const body = emailSchema.parse(req.body);
    const user = await upsertUser(pool, body.email, body.name);
    res.json({ token: signToken(user, config.JWT_SECRET), user: { id: user.id, name: user.name, color: user.color } });
  });

  // Magic link: the "email" is printed to the server console instead of being sent.
  const magicLinkPerEmail = redisRateLimit(redis, {
    name: 'magic-link',
    limit: config.MAGIC_LINK_PER_EMAIL_PER_HOUR,
    windowSeconds: 60 * 60,
    key: (req) => {
      const parsed = emailSchema.safeParse(req.body);
      return parsed.success ? parsed.data.email.trim().toLowerCase() : undefined;
    },
    log,
  });
  api.post('/auth/magic-link', magicLinkPerEmail, async (req, res) => {
    const { email } = emailSchema.parse(req.body);
    const link = await createMagicLink(redis, email, config.WEB_ORIGIN);
    log(`\n  ✉  Magic link for ${email}\n     ${link}\n`);
    res.json({ ok: true });
  });

  api.post('/auth/verify', async (req, res) => {
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(req.body);
    const email = await consumeMagicToken(redis, token);
    if (!email) throw new HttpError(401, 'Link is invalid, expired or already used');
    const user = await upsertUser(pool, email);
    res.json({ token: signToken(user, config.JWT_SECRET), user: { id: user.id, name: user.name, color: user.color } });
  });

  /* ---------- authenticated routes ---------- */

  api.use((req: Request & { userId?: string }, _res, next) => {
    const header = req.header('authorization');
    const user = verifyToken(header?.startsWith('Bearer ') ? header.slice(7) : undefined, config.JWT_SECRET);
    if (!user) throw new HttpError(401, 'Sign in required');
    req.userId = user.id;
    next();
  });

  api.get('/boards', async (req: Request & { userId?: string }, res) => {
    res.json({ boards: await service.listBoards(req.userId!) });
  });

  api.post('/boards', async (req: Request & { userId?: string }, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(LIMITS.boardName) }).parse(req.body);
    res.status(201).json(await service.createBoard(req.userId!, name));
  });

  api.get('/boards/:id', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const snapshot = await service.getSnapshot(id);
    if (!snapshot) throw new HttpError(404, 'Board not found');
    res.json(snapshot);
  });

  api.get('/boards/:id/events', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const after = z.coerce.number().int().min(0).default(0).parse(req.query.after);
    res.json({ events: await service.eventsSince(id, after, 500) });
  });

  app.use('/api', api);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof z.ZodError) return void res.status(400).json({ error: z.prettifyError(err) });
    log(`unhandled: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
