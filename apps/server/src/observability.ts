import type { RequestHandler } from 'express';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';

type Check = 'ok' | 'fail';
export interface Probes {
  postgres: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}
export interface Readiness {
  ok: boolean;
  checks: Record<keyof Probes, Check>;
}

/** Runs every probe with a deadline. A hung dependency counts as failed instead of hanging the check. */
export async function checkReadiness(
  probes: Probes,
  timeoutMs = 2000,
  onError: (dependency: string, error: unknown) => void = () => {},
): Promise<Readiness> {
  const run = async (name: keyof Probes): Promise<Check> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        probes[name](),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      return 'ok';
    } catch (err) {
      onError(name, err);
      return 'fail';
    } finally {
      clearTimeout(timer);
    }
  };
  const [postgres, redis] = await Promise.all([run('postgres'), run('redis')]);
  return { ok: postgres === 'ok' && redis === 'ok', checks: { postgres, redis } };
}

/** Probes and scrapes run every few seconds; logging them would drown the real traffic. */
const QUIET_PATHS = new Set(['/health', '/ready', '/metrics']);

/** Counts every request in the metrics and logs it (path only, never the query string). */
export function observeHttp(metrics: Metrics, log: Logger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    const path = req.originalUrl.split('?')[0] ?? '/';
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      metrics.observeRequest(req.method, route, res.statusCode, seconds);
      if (QUIET_PATHS.has(path)) return;
      log('http request', {
        level: res.statusCode >= 500 ? 'error' : 'info',
        method: req.method,
        path,
        status: res.statusCode,
        ms: Math.round(seconds * 10_000) / 10,
      });
    });
    next();
  };
}
