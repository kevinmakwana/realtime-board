import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerInstance } from '../src/server.js';
import { createWorld, startInstance } from './helpers.js';

const world = createWorld();
let inst: ServerInstance;
beforeAll(async () => {
  inst = await startInstance('rest-members');
});
afterAll(async () => {
  await inst.close();
  await world.close();
});

const call = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`http://localhost:${inst.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

type BoardList = { boards: { id: string; role: string }[] };

async function scene() {
  const owner = await world.newUser('Owner');
  const editor = await world.newUser('Ed');
  const outsider = await world.newUser('Outsider');
  const snap = await world.newBoard(owner.id, [editor.id]);
  return { owner, editor, outsider, id: snap.board.id };
}

describe('board visibility over REST', () => {
  it('lists only my boards with my role, and hides others as 404', async () => {
    const { owner, editor, outsider, id } = await scene();
    const mine = (await (await call(owner.token, 'GET', '/api/boards')).json()) as BoardList;
    expect(mine.boards.find((b) => b.id === id)?.role).toBe('owner');
    const eds = (await (await call(editor.token, 'GET', '/api/boards')).json()) as BoardList;
    expect(eds.boards.find((b) => b.id === id)?.role).toBe('editor');
    const theirs = (await (await call(outsider.token, 'GET', '/api/boards')).json()) as BoardList;
    expect(theirs.boards.map((b) => b.id)).not.toContain(id);

    expect((await call(outsider.token, 'GET', `/api/boards/${id}`)).status).toBe(404);
    expect((await call(outsider.token, 'GET', `/api/boards/${id}/events`)).status).toBe(404);
    expect((await call(editor.token, 'GET', `/api/boards/${id}`)).status).toBe(200);
    expect((await call(editor.token, 'GET', `/api/boards/${id}/events`)).status).toBe(200);
  });

  it('answers 404 for a board id that does not exist, same as for a non-member', async () => {
    const { outsider } = await scene();
    expect((await call(outsider.token, 'GET', `/api/boards/${randomUUID()}`)).status).toBe(404);
  });
});

describe('member routes', () => {
  it('lets the owner invite, change a role and remove, and hides emails from editors', async () => {
    const { owner, editor, id } = await scene();

    const invite = await call(owner.token, 'POST', `/api/boards/${id}/members`, {
      email: 'Guest@Example.test',
      role: 'viewer',
    });
    expect(invite.status).toBe(200);
    expect(await invite.json()).toEqual({ invite: { email: 'guest@example.test', role: 'viewer' } });

    const asOwner = (await (await call(owner.token, 'GET', `/api/boards/${id}/members`)).json()) as {
      members: { userId: string; email?: string }[];
      invites?: unknown[];
    };
    expect(asOwner.members.every((m) => m.email)).toBe(true);
    expect(asOwner.invites).toHaveLength(1);

    const asEditor = (await (await call(editor.token, 'GET', `/api/boards/${id}/members`)).json()) as {
      members: { email?: string }[];
      invites?: unknown[];
    };
    expect(asEditor.members.some((m) => m.email)).toBe(false);
    expect(asEditor.invites).toBeUndefined();

    expect(
      (await call(owner.token, 'PATCH', `/api/boards/${id}/members/${editor.id}`, { role: 'viewer' })).status,
    ).toBe(200);
    expect(
      (await call(owner.token, 'DELETE', `/api/boards/${id}/invites/${encodeURIComponent('guest@example.test')}`))
        .status,
    ).toBe(200);
    expect((await call(owner.token, 'DELETE', `/api/boards/${id}/members/${editor.id}`)).status).toBe(200);
    expect((await call(editor.token, 'GET', `/api/boards/${id}`)).status).toBe(404);
  });

  it('answers 403 to a member who is not the owner and 404 to a stranger', async () => {
    const { editor, outsider, owner, id } = await scene();
    const body = { email: 'x@example.test', role: 'viewer' };
    expect((await call(editor.token, 'POST', `/api/boards/${id}/members`, body)).status).toBe(403);
    expect((await call(outsider.token, 'POST', `/api/boards/${id}/members`, body)).status).toBe(404);
    expect(
      (await call(editor.token, 'PATCH', `/api/boards/${id}/members/${owner.id}`, { role: 'viewer' })).status,
    ).toBe(403);
    expect((await call(editor.token, 'DELETE', `/api/boards/${id}/members/${owner.id}`)).status).toBe(403);
  });

  it('protects the owner row and lets an editor leave', async () => {
    const { owner, editor, id } = await scene();
    expect((await call(owner.token, 'PATCH', `/api/boards/${id}/members/${owner.id}`, { role: 'viewer' })).status).toBe(
      403,
    );
    expect((await call(owner.token, 'DELETE', `/api/boards/${id}/members/${owner.id}`)).status).toBe(403);
    expect((await call(editor.token, 'DELETE', `/api/boards/${id}/members/${editor.id}`)).status).toBe(200);
  });

  it('rejects an owner role in the body and a malformed email with 400', async () => {
    const { owner, id } = await scene();
    expect(
      (await call(owner.token, 'POST', `/api/boards/${id}/members`, { email: 'x@example.test', role: 'owner' })).status,
    ).toBe(400);
    expect(
      (await call(owner.token, 'POST', `/api/boards/${id}/members`, { email: 'nope', role: 'editor' })).status,
    ).toBe(400);
    expect((await call(owner.token, 'GET', '/api/boards/not-a-uuid/members')).status).toBe(400);
  });
});
