import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AccessChange } from '@board/shared';
import { upsertUser } from '../src/auth.js';
import { MembershipService } from '../src/membership.js';
import { createWorld } from './helpers.js';

const world = createWorld();
afterAll(() => world.close());

function setup() {
  const changes: AccessChange[] = [];
  const members = new MembershipService(world.pool, (c) => changes.push(c));
  return { members, changes };
}
const email = () => `${randomUUID()}@example.test`;

async function boardWith() {
  const owner = await world.newUser('Owner');
  const editor = await world.newUser('Ed');
  const viewer = await world.newUser('Vic');
  const outsider = await world.newUser('Outsider');
  const snap = await world.newBoard(owner.id, [editor.id]);
  await world.pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'viewer')", [
    snap.board.id,
    viewer.id,
  ]);
  return { owner, editor, viewer, outsider, boardId: snap.board.id };
}

const emailOf = async (userId: string) =>
  (await world.pool.query('SELECT email FROM users WHERE id = $1', [userId])).rows[0].email as string;

describe('listing members', () => {
  it('shows the owner emails and pending invites, and everyone else only names and roles', async () => {
    const { members } = setup();
    const { owner, editor, boardId } = await boardWith();
    await members.addMember(boardId, owner.id, 'pending@example.test', 'viewer');

    const asOwner = await members.listMembers(boardId, owner.id);
    expect(asOwner.members.map((m) => m.role)).toEqual(['owner', 'editor', 'viewer']);
    expect(asOwner.members.every((m) => m.email)).toBe(true);
    expect(asOwner.invites).toEqual([{ email: 'pending@example.test', role: 'viewer' }]);

    const asEditor = await members.listMembers(boardId, editor.id);
    expect(asEditor.members).toHaveLength(3);
    expect(asEditor.members.some((m) => m.email)).toBe(false);
    expect(asEditor.invites).toBeUndefined();
  });

  it('treats a non-member as if the board did not exist', async () => {
    const { members } = setup();
    const { outsider, boardId } = await boardWith();
    await expect(members.listMembers(boardId, outsider.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('inviting', () => {
  it('adds an existing user straight away', async () => {
    const { members } = setup();
    const { owner, outsider, boardId } = await boardWith();
    const result = await members.addMember(boardId, owner.id, await emailOf(outsider.id), 'editor');
    expect(result).toMatchObject({ member: { userId: outsider.id, role: 'editor' } });
    expect(await world.service.role(boardId, outsider.id)).toBe('editor');
  });

  it('keeps one pending invite per address whatever its casing, and the latest role wins', async () => {
    const { members } = setup();
    const { owner, boardId } = await boardWith();
    await members.addMember(boardId, owner.id, 'Newbie@Example.test', 'viewer');
    await members.addMember(boardId, owner.id, 'newbie@example.test', 'editor');
    const { invites } = await members.listMembers(boardId, owner.id);
    expect(invites).toEqual([{ email: 'newbie@example.test', role: 'editor' }]);
  });

  it('is a no-op for someone who is already a member, including the owner', async () => {
    const { members } = setup();
    const { owner, editor, boardId } = await boardWith();
    const again = await members.addMember(boardId, owner.id, await emailOf(editor.id), 'viewer');
    expect(again).toMatchObject({ member: { userId: editor.id, role: 'editor' } }); // role unchanged
    const self = await members.addMember(boardId, owner.id, await emailOf(owner.id), 'viewer');
    expect(self).toMatchObject({ member: { userId: owner.id, role: 'owner' } });
  });

  it('only the owner can invite', async () => {
    const { members } = setup();
    const { editor, viewer, outsider, boardId } = await boardWith();
    await expect(members.addMember(boardId, editor.id, email(), 'viewer')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(members.addMember(boardId, viewer.id, email(), 'viewer')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(members.addMember(boardId, outsider.id, email(), 'viewer')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('claims pending invites when the invited person first signs in, once', async () => {
    const { members } = setup();
    const { owner, boardId } = await boardWith();
    const invitee = email();
    await members.addMember(boardId, owner.id, invitee, 'editor');

    const user = await upsertUser(world.pool, invitee, 'New Person');
    expect(await world.service.role(boardId, user.id)).toBe('editor');
    expect((await members.listMembers(boardId, owner.id)).invites).toEqual([]);

    await upsertUser(world.pool, invitee); // signing in again changes nothing
    expect(await world.service.role(boardId, user.id)).toBe('editor');
  });

  it('can withdraw a pending invite', async () => {
    const { members } = setup();
    const { owner, boardId } = await boardWith();
    const invitee = email();
    await members.addMember(boardId, owner.id, invitee, 'viewer');
    await members.removeInvite(boardId, owner.id, invitee);
    const user = await upsertUser(world.pool, invitee);
    expect(await world.service.role(boardId, user.id)).toBeNull();
  });
});

describe('changing and removing members', () => {
  it('changes a role and reports the change so live sockets can follow', async () => {
    const { members, changes } = setup();
    const { owner, editor, boardId } = await boardWith();
    await members.setRole(boardId, owner.id, editor.id, 'viewer');
    expect(await world.service.role(boardId, editor.id)).toBe('viewer');
    expect(changes).toEqual([{ boardId, userId: editor.id, role: 'viewer' }]);
  });

  it('never changes or removes the owner', async () => {
    const { members } = setup();
    const { owner, boardId } = await boardWith();
    await expect(members.setRole(boardId, owner.id, owner.id, 'viewer')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(members.removeMember(boardId, owner.id, owner.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await world.service.role(boardId, owner.id)).toBe('owner');
  });

  it('only the owner changes roles or removes others', async () => {
    const { members } = setup();
    const { editor, viewer, boardId } = await boardWith();
    await expect(members.setRole(boardId, editor.id, viewer.id, 'editor')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(members.removeMember(boardId, editor.id, viewer.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('removes a member, reports it, and lets a member leave on their own', async () => {
    const { members, changes } = setup();
    const { owner, editor, viewer, boardId } = await boardWith();
    await members.removeMember(boardId, owner.id, editor.id);
    expect(await world.service.role(boardId, editor.id)).toBeNull();
    await members.removeMember(boardId, viewer.id, viewer.id); // leaving
    expect(await world.service.role(boardId, viewer.id)).toBeNull();
    expect(changes).toEqual([
      { boardId, userId: editor.id, role: null },
      { boardId, userId: viewer.id, role: null },
    ]);
  });

  it('answers NOT_FOUND for someone who is not on the board', async () => {
    const { members } = setup();
    const { owner, outsider, boardId } = await boardWith();
    await expect(members.removeMember(boardId, owner.id, outsider.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(members.setRole(boardId, owner.id, outsider.id, 'viewer')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('notifications', () => {
  it('does not notify when nothing changed', async () => {
    const onChange = vi.fn();
    const members = new MembershipService(world.pool, onChange);
    const { owner, editor, boardId } = await boardWith();
    await members.addMember(boardId, owner.id, await emailOf(editor.id), 'viewer');
    await members.setRole(boardId, owner.id, editor.id, 'editor'); // already an editor
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ordering against in-flight commands', () => {
  it('a removal waits for a command that already passed its role check, so no write lands after it', async () => {
    const { members } = setup();
    const { owner, editor, boardId } = await boardWith();
    const columnId = (await world.pool.query('SELECT id FROM columns WHERE board_id = $1 LIMIT 1', [boardId])).rows[0]
      .id as string;

    // Stall the command right after its role check: it needs to read `cards` next.
    const blocker = await world.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE cards IN ACCESS EXCLUSIVE MODE');
    let removal: Promise<void> = Promise.resolve();
    let command: ReturnType<typeof world.service.createCard>;
    try {
      command = world.service.createCard(editor.id, {
        id: randomUUID(),
        boardId,
        columnId,
        title: 'In flight',
        position: 'a0',
      });
      await new Promise((r) => setTimeout(r, 250));

      removal = members.removeMember(boardId, owner.id, editor.id);
      await new Promise((r) => setTimeout(r, 300));
      // The removal must queue behind the command instead of overtaking it.
      expect(await world.service.role(boardId, editor.id)).toBe('editor');
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }
    await expect(command).resolves.toMatchObject({ seq: 1 });
    await removal;
    expect(await world.service.role(boardId, editor.id)).toBeNull();
  });
});
