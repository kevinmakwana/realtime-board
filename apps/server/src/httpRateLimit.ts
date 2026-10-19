import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import type { Logger } from './logger.js';

interface Options {
  /** Short name, part of the Redis key and the error message. */
  name: string;
  limit: number;
  windowSeconds: number;
  /** What to count by. Return undefined to skip limiting (e.g. the request is malformed and will be rejected anyway). */
  key: (req: Request) => string | undefined;
  log: Logger;
}

/**
 * Fixed-window request limiter backed by Redis, so the budget is shared by every server instance
 * (an in-process limiter would let a client multiply its budget by the number of instances).
 *
 * It fails open: if Redis is down the request goes through and the problem is logged, because
 * the routes it guards already need Redis for their own work and we do not want to turn a Redis
 * blip into a hard lock-out.
 */
export function redisRateLimit(redis: Redis, { name, limit, windowSeconds, key, log }: Options): RequestHandler {
  return async (req, res, next) => {
    const id = key(req);
    if (id === undefined) return next();
    const redisKey = `rl:${name}:${id}`;
    try {
      // EXPIRE ... NX sets the window only on the first hit, so later hits cannot extend it.
      const results = await redis.multi().incr(redisKey).expire(redisKey, windowSeconds, 'NX').ttl(redisKey).exec();
      const count = Number(results?.[0]?.[1] ?? 0);
      const ttl = Number(results?.[2]?.[1] ?? windowSeconds);
      if (count > limit) {
        const retryAfter = ttl > 0 ? ttl : windowSeconds;
        res.set('Retry-After', String(retryAfter));
        res.status(429).json({ error: `Too many ${name} requests. Try again in ${retryAfter}s.` });
        return;
      }
    } catch (err) {
      log('rate limiter failed open', { level: 'warn', limiter: name, error: String(err) });
    }
    next();
  };
}
