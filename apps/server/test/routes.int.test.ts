import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerInstance } from '../src/server.js';
import { createWorld, startInstance, type TestWorld } from './helpers.js';

// A route-by-route pass over app.ts: who may call it, what bad input does, and that every failure is a
// JSON body with the right status instead of a stack trace.
describe('REST routes', () => {
  const world: TestWorld = createWorld();
  let server: ServerInstance;
  let base: string;
  beforeAll(async () => {
    server = await startInstance('routes-a');
    base = `http://localhost:${server.port}`;
  });
  afterAll(async () => {
    await world.close();
    await server.close();
  });

  const call = async (method: string, path: string, opts: { token?: string; body?: unknown; raw?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: string | undefined;
    if (opts.raw !== undefined) {
      body = opts.raw;
      headers['content-type'] = 'application/json';
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(`${base}${path}`, { method, headers, body });
    const json = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    return { status: res.status, json };
  };

  describe('authentication', () => {
    const boardId = randomUUID();
    const userId = randomUUID();
    const protectedRoutes: [string, string][] = [
      ['GET', '/api/boards'],
      ['POST', '/api/boards'],
      ['GET', `/api/boards/${boardId}`],
      ['DELETE', `/api/boards/${boardId}`],
      ['GET', `/api/boards/${boardId}/events`],
      ['GET', `/api/boards/${boardId}/activity`],
      ['GET', `/api/boards/${boardId}/members`],
      ['POST', `/api/boards/${boardId}/members`],
      ['PATCH', `/api/boards/${boardId}/members/${userId}`],
      ['DELETE', `/api/boards/${boardId}/members/${userId}`],
      ['DELETE', `/api/boards/${boardId}/invites/someone%40example.test`],
    ];

    it.each(protectedRoutes)('%s %s needs a token', async (method, path) => {
      const res = await call(method, path);
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: 'Sign in required' });
    });

    it('rejects a malformed, wrongly signed or non-Bearer token', async () => {
      expect((await call('GET', '/api/boards', { token: 'not-a-jwt' })).status).toBe(401);
      const { token } = await world.newUser();
      const tampered = `${token.slice(0, -2)}xx`;
      expect((await call('GET', '/api/boards', { token: tampered })).status).toBe(401);
      const res = await fetch(`${base}/api/boards`, { headers: { authorization: `Basic ${token}` } });
      expect(res.status).toBe(401);
    });
  });

  describe('input handling', () => {
    it('answers a malformed id with 400 on every board route', async () => {
      const { token } = await world.newUser();
      for (const [method, path] of [
        ['GET', '/api/boards/nope'],
        ['DELETE', '/api/boards/nope'],
        ['GET', '/api/boards/nope/events'],
        ['GET', '/api/boards/nope/activity'],
        ['GET', '/api/boards/nope/members'],
        ['PATCH', `/api/boards/${randomUUID()}/members/nope`],
        ['DELETE', `/api/boards/${randomUUID()}/members/nope`],
      ] as const) {
        const res = await call(method, path, { token, body: method === 'PATCH' ? { role: 'viewer' } : undefined });
        expect(res.status, `${method} ${path}`).toBe(400);
        expect(res.json).toHaveProperty('error');
      }
    });

    it('validates the board name', async () => {
      const { token } = await world.newUser();
      for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(200) }, { name: 7 }]) {
        expect((await call('POST', '/api/boards', { token, body })).status, JSON.stringify(body)).toBe(400);
      }
      const ok = await call('POST', '/api/boards', { token, body: { name: '  Roadmap  ' } });
      expect(ok.status).toBe(201);
      expect((ok.json as { board: { name: string } }).board.name).toBe('Roadmap');
    });

    it('answers invalid JSON with 400, not 500', async () => {
      const { token } = await world.newUser();
      const res = await call('POST', '/api/boards', { token, raw: '{"name": ' });
      expect(res.status).toBe(400);
      expect(res.json).toHaveProperty('error');
    });

    it('answers an oversized body with 413, not 500', async () => {
      const { token } = await world.newUser();
      const res = await call('POST', '/api/boards', { token, body: { name: 'x'.repeat(40_000) } });
      expect(res.status).toBe(413);
      expect(res.json).toHaveProperty('error');
    });

    it('validates the catch-up cursor and the activity limit', async () => {
      const { id, token } = await world.newUser();
      const snap = await world.newBoard(id);
      const events = (query: string) => call('GET', `/api/boards/${snap.board.id}/events${query}`, { token });
      expect((await events('')).status).toBe(200);
      expect((await events('?after=0')).status).toBe(200);
      for (const bad of ['?after=-1', '?after=abc', '?after=1.5']) {
        expect((await events(bad)).status, bad).toBe(400);
      }
      const activity = (query: string) => call('GET', `/api/boards/${snap.board.id}/activity${query}`, { token });
      for (const bad of ['?limit=0', '?limit=-3', '?limit=abc']) {
        expect((await activity(bad)).status, bad).toBe(400);
      }
      expect((await activity('?limit=100000')).status).toBe(200);
    });

    it('rejects an unknown member id and a missing role without touching anything', async () => {
      const owner = await world.newUser();
      const snap = await world.newBoard(owner.id);
      const path = `/api/boards/${snap.board.id}/members`;
      expect((await call('POST', path, { token: owner.token, body: { email: 'a@example.test' } })).status).toBe(400);
      expect((await call('POST', path, { token: owner.token, body: { role: 'editor' } })).status).toBe(400);
      expect(
        (await call('PATCH', `${path}/${randomUUID()}`, { token: owner.token, body: { role: 'wizard' } })).status,
      ).toBe(400);
      expect(
        (await call('DELETE', `${path.replace('members', 'invites')}/not-an-email`, { token: owner.token })).status,
      ).toBe(400);
    });
  });

  describe('events and activity', () => {
    it('returns the events after a cursor, in order, to any member including a viewer', async () => {
      const owner = await world.newUser();
      const viewer = await world.newUser();
      const snap = await world.newBoard(owner.id);
      await world.pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'viewer')", [
        snap.board.id,
        viewer.id,
      ]);
      const col = snap.columns[0]!;
      for (const [title, position] of [
        ['First', 'a0'],
        ['Second', 'a1'],
      ] as const) {
        await world.service.createCard(owner.id, {
          boardId: snap.board.id,
          id: randomUUID(),
          columnId: col.id,
          title,
          position,
        });
      }

      const all = await call('GET', `/api/boards/${snap.board.id}/events`, { token: viewer.token });
      expect(all.status).toBe(200);
      const seqs = (all.json as { events: { seq: number }[] }).events.map((e) => e.seq);
      expect(seqs.length).toBeGreaterThanOrEqual(2);
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y));

      const after = await call('GET', `/api/boards/${snap.board.id}/events?after=${seqs[seqs.length - 2]}`, {
        token: owner.token,
      });
      expect((after.json as { events: { seq: number }[] }).events.map((e) => e.seq)).toEqual([seqs[seqs.length - 1]]);
    });

    it('hides events, activity, snapshot and members of a board from a stranger', async () => {
      const owner = await world.newUser();
      const stranger = await world.newUser();
      const snap = await world.newBoard(owner.id);
      for (const suffix of ['', '/events', '/activity', '/members']) {
        const res = await call('GET', `/api/boards/${snap.board.id}${suffix}`, { token: stranger.token });
        expect(res.status, suffix).toBe(404);
      }
    });
  });

  describe('everything else', () => {
    it('answers an unknown route with a JSON 404', async () => {
      const { token } = await world.newUser();
      for (const path of ['/nope', '/api/nope']) {
        const res = await call('GET', path, { token });
        expect(res.status, path).toBe(404);
        expect(res.json).toEqual({ error: 'Not found' });
      }
    });

    it('serves /health and /ready without a token, and /metrics as Prometheus text', async () => {
      const health = await call('GET', '/health');
      expect(health.status).toBe(200);
      expect(health.json).toMatchObject({ ok: true, instance: 'routes-a' });
      const ready = await call('GET', '/ready');
      expect(ready.status).toBe(200);
      expect(ready.json).toMatchObject({ ok: true });
      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      expect(metrics.headers.get('content-type')).toMatch(/text\/plain/);
    });

    it('refuses dev login when it is switched off', async () => {
      const off = await startInstance('routes-nodev', { AUTH_DEV_LOGIN: false });
      try {
        const res = await fetch(`http://localhost:${off.port}/api/auth/dev-login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'a@example.test' }),
        });
        expect(res.status).toBe(404);
      } finally {
        await off.close();
      }
    });

    it('rejects a bad email and a bad verify token on the sign-in routes', async () => {
      for (const [path, body] of [
        ['/api/auth/dev-login', { email: 'nope' }],
        ['/api/auth/magic-link', { email: 'nope' }],
        ['/api/auth/verify', { token: 'short' }],
        ['/api/auth/verify', {}],
      ] as const) {
        expect((await call('POST', path, { body })).status, path).toBe(400);
      }
      const unknown = await call('POST', '/api/auth/verify', { body: { token: 'x'.repeat(40) } });
      expect(unknown.status).toBe(401);
    });
  });
});
