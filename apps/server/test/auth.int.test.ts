import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerInstance } from '../src/server.js';
import { createServerInstance } from '../src/server.js';
import { baseConfig } from './helpers.js';

describe('auth + REST', () => {
  let inst: ServerInstance;
  const logs: string[] = [];
  const url = (p: string) => `http://localhost:${inst.port}${p}`;
  const post = (p: string, body: unknown, token?: string) =>
    fetch(url(p), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    inst = await createServerInstance(baseConfig({ INSTANCE_ID: 'auth' }), (m) => logs.push(m));
  });
  afterAll(() => inst.close());

  it('prints a single-use magic link to the console and exchanges it for a JWT', async () => {
    const email = `magic-${Date.now()}@example.test`;
    expect((await post('/api/auth/magic-link', { email })).status).toBe(200);
    const link = logs.join('\n').match(/https?:\/\/\S+token=([a-f0-9]+)/);
    expect(link).toBeTruthy();
    const token = link![1]!;

    const ok = await post('/api/auth/verify', { token });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { token: string; user: { name: string } };
    expect(body.token.split('.')).toHaveLength(3);

    const replay = await post('/api/auth/verify', { token });
    expect(replay.status).toBe(401);
  });

  it('requires a token for the API, and lets a signed-in user create and fetch a board', async () => {
    expect((await fetch(url('/api/boards'))).status).toBe(401);
    const login = (await (await post('/api/auth/dev-login', { email: `dev-${Date.now()}@example.test`, name: 'Dev User' })).json()) as {
      token: string;
    };
    const created = await post('/api/boards', { name: 'Roadmap' }, login.token);
    expect(created.status).toBe(201);
    const snap = (await created.json()) as { board: { id: string }; columns: unknown[]; seq: number };
    expect(snap.columns).toHaveLength(3);
    expect(snap.seq).toBe(0);

    const fetched = await fetch(url(`/api/boards/${snap.board.id}`), { headers: { authorization: `Bearer ${login.token}` } });
    expect(fetched.status).toBe(200);
    const bad = await post('/api/boards', { name: '' }, login.token);
    expect(bad.status).toBe(400);
  });

  it('exposes the instance id on /health', async () => {
    expect(await (await fetch(url('/health'))).json()).toEqual({ ok: true, instance: 'auth' });
  });
});
