import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Mail, Mailer } from '../src/mailer.js';
import { type ServerInstance, createServerInstance } from '../src/server.js';
import { baseConfig, createWorld } from './helpers.js';

class FakeMailer implements Mailer {
  sent: Mail[] = [];
  fail = false;
  async send(mail: Mail): Promise<void> {
    if (this.fail) throw new Error('smtp is down');
    this.sent.push(mail);
  }
}

describe('sign-in and invitation emails', () => {
  const world = createWorld();
  const mailer = new FakeMailer();
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  let inst: ServerInstance;
  const origin = baseConfig().WEB_ORIGIN;

  beforeAll(async () => {
    inst = await createServerInstance(
      baseConfig({ INSTANCE_ID: 'mail', AUTH_RATE_LIMIT_PER_MIN: 1000 }),
      (message, fields) => logs.push({ message, fields }),
      { mailer },
    );
  });
  afterAll(async () => {
    await inst.close();
    await world.close();
  });

  const post = (path: string, body: unknown, token?: string) =>
    fetch(`http://localhost:${inst.port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  const unique = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;

  it('emails the magic link, and the link works once', async () => {
    mailer.sent.length = 0;
    const email = unique('magic');
    expect((await post('/api/auth/magic-link', { email })).status).toBe(200);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe(email);
    const token = mailer.sent[0]?.text.match(new RegExp(`${origin}/auth/verify\\?token=([a-f0-9]+)`))?.[1];
    expect(token).toBeTruthy();
    expect((await post('/api/auth/verify', { token })).status).toBe(200);
    expect((await post('/api/auth/verify', { token })).status).toBe(401);
  });

  it('answers the same way when the mail server is down, and logs why', async () => {
    mailer.fail = true;
    try {
      const res = await post('/api/auth/magic-link', { email: unique('down') });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      mailer.fail = false;
    }
    const failure = logs.find((l) => l.message.includes('failed to send the sign-in link'));
    expect(failure?.fields).toMatchObject({ level: 'error' });
    expect(JSON.stringify(failure)).toContain('smtp is down');
  });

  it('emails a pending invite to an address with no account, and a direct invite to an existing user', async () => {
    mailer.sent.length = 0;
    const owner = await world.newUser('Ada Lovelace');
    const existing = await world.newUser('Grace');
    const snap = await world.newBoard(owner.id);
    const existingEmail = (await world.pool.query('SELECT email FROM users WHERE id = $1', [existing.id])).rows[0]
      .email as string;
    const newcomer = unique('newcomer');

    expect(
      (await post(`/api/boards/${snap.board.id}/members`, { email: newcomer, role: 'viewer' }, owner.token)).status,
    ).toBe(200);
    expect(
      (await post(`/api/boards/${snap.board.id}/members`, { email: existingEmail, role: 'editor' }, owner.token))
        .status,
    ).toBe(200);

    expect(mailer.sent.map((m) => m.to)).toEqual([newcomer, existingEmail]);
    const [invite, direct] = mailer.sent;
    expect(invite?.subject).toBe(`Ada Lovelace invited you to "${snap.board.name}"`);
    expect(invite?.text).toContain('viewer');
    expect(invite?.text).toContain(`${origin}/boards/${snap.board.id}`);
    expect(direct?.text).toContain('editor');
  });

  it('sends nothing when the person is already on the board', async () => {
    const owner = await world.newUser('Ada');
    const editor = await world.newUser('Ed');
    const snap = await world.newBoard(owner.id, [editor.id]);
    const edEmail = (await world.pool.query('SELECT email FROM users WHERE id = $1', [editor.id])).rows[0]
      .email as string;
    mailer.sent.length = 0;
    expect(
      (await post(`/api/boards/${snap.board.id}/members`, { email: edEmail, role: 'viewer' }, owner.token)).status,
    ).toBe(200);
    expect(mailer.sent).toEqual([]);
  });

  it('still records the invitation when the notification cannot be sent', async () => {
    const owner = await world.newUser('Ada');
    const snap = await world.newBoard(owner.id);
    const email = unique('offline');
    mailer.fail = true;
    try {
      const res = await post(`/api/boards/${snap.board.id}/members`, { email, role: 'editor' }, owner.token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ invite: { email, role: 'editor' } });
    } finally {
      mailer.fail = false;
    }
  });
});
