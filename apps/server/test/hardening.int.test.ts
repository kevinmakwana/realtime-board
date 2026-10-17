import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServerInstance, type ServerInstance } from '../src/server.js';
import { baseConfig, createWorld } from './helpers.js';
import type { Config } from '../src/config.js';

const world = createWorld();

/** Rate-limit counters live in Redis and are shared by every test file, so start each test clean. */
async function clearLimits() {
  const keys = await world.redis.keys('rl:*');
  if (keys.length) await world.redis.del(...keys);
}

async function start(over: Partial<Config>): Promise<ServerInstance> {
  return createServerInstance(baseConfig({ INSTANCE_ID: 'hardening', ...over }));
}

const post = (inst: ServerInstance, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://localhost:${inst.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

beforeEach(clearLimits);
afterAll(async () => {
  await clearLimits();
  await world.close();
});

describe('security headers', () => {
  let inst: ServerInstance;
  beforeAll(async () => {
    inst = await start({});
  });
  afterAll(() => inst.close());

  it('sends helmet defaults and hides x-powered-by', async () => {
    const res = await fetch(`http://localhost:${inst.port}/health`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});

describe('auth route rate limiting (per IP)', () => {
  let inst: ServerInstance;
  beforeAll(async () => {
    inst = await start({ AUTH_RATE_LIMIT_PER_MIN: 3, TRUST_PROXY: 0 });
  });
  afterAll(() => inst.close());

  it('answers 429 with Retry-After once the budget is spent, across all three auth routes', async () => {
    expect((await post(inst, '/api/auth/verify', { token: 'not-a-real-token' })).status).toBe(401);
    expect((await post(inst, '/api/auth/magic-link', { email: 'a@example.test' })).status).toBe(200);
    expect((await post(inst, '/api/auth/dev-login', { email: 'b@example.test' })).status).toBe(200);

    const blocked = await post(inst, '/api/auth/verify', { token: 'not-a-real-token' });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await blocked.json()).toEqual({ error: expect.stringMatching(/too many/i) });
  });

  it('does not let a spoofed X-Forwarded-For dodge the limit when no proxy is trusted', async () => {
    for (let i = 0; i < 3; i++)
      await post(inst, '/api/auth/verify', { token: 'not-a-real-token' }, { 'x-forwarded-for': `9.9.9.${i}` });
    const res = await post(inst, '/api/auth/verify', { token: 'not-a-real-token' }, { 'x-forwarded-for': '9.9.9.200' });
    expect(res.status).toBe(429);
  });

  it('leaves the rest of the API alone', async () => {
    for (let i = 0; i < 5; i++) await post(inst, '/api/auth/verify', { token: 'not-a-real-token' });
    expect((await fetch(`http://localhost:${inst.port}/health`)).status).toBe(200);
    expect((await fetch(`http://localhost:${inst.port}/api/boards`)).status).toBe(401); // auth failure, not 429
  });
});

describe('auth route rate limiting behind a trusted proxy', () => {
  let inst: ServerInstance;
  beforeAll(async () => {
    inst = await start({ AUTH_RATE_LIMIT_PER_MIN: 2, TRUST_PROXY: 1 });
  });
  afterAll(() => inst.close());

  it('counts each forwarded client separately', async () => {
    const as = (ip: string) => post(inst, '/api/auth/verify', { token: 'not-a-real-token' }, { 'x-forwarded-for': ip });
    await as('1.1.1.1');
    await as('1.1.1.1');
    expect((await as('1.1.1.1')).status).toBe(429);
    expect((await as('2.2.2.2')).status).toBe(401); // a different client still has budget
  });
});

describe('magic-link rate limiting (per email)', () => {
  let inst: ServerInstance;
  beforeAll(async () => {
    inst = await start({ AUTH_RATE_LIMIT_PER_MIN: 1000, MAGIC_LINK_PER_EMAIL_PER_HOUR: 2 });
  });
  afterAll(() => inst.close());

  it('stops one address from being flooded with links, whatever its casing', async () => {
    expect((await post(inst, '/api/auth/magic-link', { email: 'victim@example.test' })).status).toBe(200);
    expect((await post(inst, '/api/auth/magic-link', { email: 'VICTIM@example.test' })).status).toBe(200);
    const blocked = await post(inst, '/api/auth/magic-link', { email: 'Victim@Example.test' });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await post(inst, '/api/auth/magic-link', { email: 'someone-else@example.test' })).status).toBe(200);
  });
});
