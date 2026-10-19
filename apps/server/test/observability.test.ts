import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMetrics } from '../src/metrics.js';
import { checkReadiness } from '../src/observability.js';

describe('checkReadiness', () => {
  const ok = async () => 'fine';

  it('is ready when every dependency answers', async () => {
    expect(await checkReadiness({ postgres: ok, redis: ok }, 200)).toEqual({
      ok: true,
      checks: { postgres: 'ok', redis: 'ok' },
    });
  });

  it('names the dependency that failed or hung, and does not wait for it forever', async () => {
    const broken = async () => {
      throw new Error('connection refused');
    };
    const hung = () => new Promise<never>(() => {});
    const started = Date.now();
    expect(await checkReadiness({ postgres: broken, redis: ok }, 100)).toEqual({
      ok: false,
      checks: { postgres: 'fail', redis: 'ok' },
    });
    expect(await checkReadiness({ postgres: ok, redis: hung }, 100)).toEqual({
      ok: false,
      checks: { postgres: 'ok', redis: 'fail' },
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('health endpoints', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function start(deps: { postgres: () => Promise<unknown>; redis: () => Promise<unknown> }) {
    const logs: { message: string; fields?: Record<string, unknown> }[] = [];
    const config = loadConfig({}, { INSTANCE_ID: 'probe-test' });
    const app = createApp({
      config,
      pool: { query: deps.postgres } as never,
      redis: { ping: deps.redis } as never,
      service: {} as never,
      membership: {} as never,
      mailer: { send: async () => {} },
      metrics: createMetrics('probe-test'),
      log: (message, fields) => logs.push({ message, fields }),
    });
    server = createServer(app);
    await new Promise<void>((r) => server!.listen(0, r));
    return { base: `http://localhost:${(server.address() as AddressInfo).port}`, logs };
  }

  it('/ready answers 200 when Postgres and Redis respond', async () => {
    const { base } = await start({ postgres: async () => ({}), redis: async () => 'PONG' });
    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      instance: 'probe-test',
      checks: { postgres: 'ok', redis: 'ok' },
    });
  });

  it('/ready answers 503 with the failing dependency, without leaking the error, and logs why', async () => {
    const { base, logs } = await start({
      postgres: async () => {
        throw new Error('password authentication failed for user "board"');
      },
      redis: async () => 'PONG',
    });
    const res = await fetch(`${base}/ready`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ ok: false, instance: 'probe-test', checks: { postgres: 'fail', redis: 'ok' } });
    expect(JSON.stringify(body)).not.toContain('password');
    const logged = logs.find((l) => l.message.includes('not ready'));
    expect(logged?.fields?.level).toBe('error');
    expect(JSON.stringify(logged)).toContain('password authentication failed');
  });

  it('/health stays a liveness check that does not touch any dependency', async () => {
    const { base } = await start({
      postgres: async () => {
        throw new Error('down');
      },
      redis: async () => {
        throw new Error('down');
      },
    });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, instance: 'probe-test' });
  });
});
