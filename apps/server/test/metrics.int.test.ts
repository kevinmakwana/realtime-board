import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyBetween } from '@board/shared';
import { randomUUID } from 'node:crypto';
import { type ServerInstance, createServerInstance } from '../src/server.js';
import { baseConfig, createWorld, emit, join } from './helpers.js';

/** Value of the first sample of `name` whose labels include all of `labels`, or undefined. */
function sample(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    if (Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) return Number(line.split(' ').at(-1));
  }
  return undefined;
}

describe('metrics and request logs', () => {
  const world = createWorld();
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  let inst: ServerInstance;
  beforeAll(async () => {
    inst = await createServerInstance(baseConfig({ INSTANCE_ID: 'metrics-test' }), (message, fields) =>
      logs.push({ message, fields }),
    );
  });
  afterAll(async () => {
    await inst.close();
    await world.close();
  });

  const url = (p: string) => `http://localhost:${inst.port}${p}`;
  const scrape = async () => (await fetch(url('/metrics'))).text();

  it('serves Prometheus text with process metrics labelled by instance', async () => {
    const res = await fetch(url('/metrics'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    const text = await res.text();
    expect(text).toContain('process_cpu_user_seconds_total');
    expect(text).toContain('instance="metrics-test"');
  });

  it('counts HTTP requests by method, route and status, and logs them without query strings', async () => {
    const ada = await world.newUser('Ada');
    const before = (await sample(await scrape(), 'http_requests_total', { route: '/api/boards', status: '200' })) ?? 0;
    const res = await fetch(url('/api/boards?secret=nope'), { headers: { authorization: `Bearer ${ada.token}` } });
    expect(res.status).toBe(200);

    const after = await sample(await scrape(), 'http_requests_total', {
      method: 'GET',
      route: '/api/boards',
      status: '200',
    });
    expect(after).toBe(before + 1);

    const logged = logs.find((l) => l.message === 'http request' && l.fields?.path === '/api/boards');
    expect(logged?.fields).toMatchObject({ method: 'GET', path: '/api/boards', status: 200 });
    expect(typeof logged?.fields?.ms).toBe('number');
    expect(JSON.stringify(logs)).not.toContain('secret=nope');
  });

  it('keeps probes and scrapes out of the request log', async () => {
    logs.length = 0;
    await fetch(url('/health'));
    await fetch(url('/ready'));
    await fetch(url('/metrics'));
    expect(logs.filter((l) => l.message === 'http request')).toEqual([]);
  });

  it('reports /ready as 200 against the real Postgres and Redis', async () => {
    const res = await fetch(url('/ready'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, checks: { postgres: 'ok', redis: 'ok' } });
  });

  it('tracks connected sockets as they come and go', async () => {
    const ada = await world.newUser('Ada');
    const base = (await sample(await scrape(), 'ws_connections')) ?? 0;
    const a = await world.connect(inst.port, ada.token);
    const b = await world.connect(inst.port, ada.token);
    expect(await sample(await scrape(), 'ws_connections')).toBe(base + 2);
    a.disconnect();
    b.disconnect();
    await expect.poll(async () => sample(await scrape(), 'ws_connections'), { timeout: 5000 }).toBe(base);
  });

  it('counts board commands by type and outcome, with a duration histogram', async () => {
    const ada = await world.newUser('Ada');
    const vic = await world.newUser('Vic');
    const snap = await world.newBoard(ada.id);
    await world.pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'viewer')", [
      snap.board.id,
      vic.id,
    ]);
    const card = () => ({
      id: randomUUID(),
      boardId: snap.board.id,
      columnId: snap.columns[0]!.id,
      title: 'Card',
      position: keyBetween(null, null),
    });
    const sa = await world.connect(inst.port, ada.token);
    const sv = await world.connect(inst.port, vic.token);
    await join(sa, snap.board.id);
    await join(sv, snap.board.id);

    const before = await scrape();
    const ok0 = sample(before, 'board_commands_total', { command: 'card:create', result: 'ok' }) ?? 0;
    const forbidden0 = sample(before, 'board_commands_total', { command: 'card:create', result: 'FORBIDDEN' }) ?? 0;
    const hist0 = sample(before, 'board_command_duration_seconds_count', { command: 'card:create' }) ?? 0;

    expect(await emit(sa, 'card:create', card())).toMatchObject({ ok: true });
    expect(await emit(sv, 'card:create', card())).toMatchObject({ ok: false, code: 'FORBIDDEN' });

    const after = await scrape();
    expect(sample(after, 'board_commands_total', { command: 'card:create', result: 'ok' })).toBe(ok0 + 1);
    expect(sample(after, 'board_commands_total', { command: 'card:create', result: 'FORBIDDEN' })).toBe(forbidden0 + 1);
    expect(sample(after, 'board_command_duration_seconds_count', { command: 'card:create' })).toBe(hist0 + 2);
  });
});
