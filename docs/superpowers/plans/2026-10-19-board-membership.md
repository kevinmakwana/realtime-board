# Board Membership and Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only members can see or change a board, with owner / editor / viewer roles, email invites, live revocation across server instances, a Share dialog and a read-only viewer mode.

**Architecture:** A `board_members` table (plus `board_invites` for people without an account) is the source of truth. The role is checked at `board:join` and again inside every command's board-locked transaction, so a revoked user's next write fails at once. Role changes and removals are applied to live sockets on every instance through `io.serverSideEmit`. REST member routes live in a separate `MembershipService`.

**Tech Stack:** Node 22, Express 5, Socket.IO 4 + Redis adapter, Postgres (`pg`), zod 4, React 19, Vitest 5, Playwright, Biome.

**Spec:** `docs/superpowers/specs/2026-10-18-board-membership-design.md`

## Global Constraints

- TypeScript strict; Biome (`npm run lint`) must stay clean; format with `npm run format`.
- Test-first: every behaviour change starts with a test that is watched failing.
- Roles are exactly `owner | editor | viewer`; invites can only grant `editor | viewer`; exactly one owner per board.
- A non-member always gets the same response as for a missing board (`NOT_FOUND` on sockets, HTTP 404).
- Emails are visible only to the owner; members see name, colour and role.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Integration tests need `npm run infra:up` (Postgres 5434, Redis 6381).

## Review Focus

- A member removed while a command is in flight on another instance: the write either lands before the removal or is refused; it never lands after (Task 2 test: command after removal is `NOT_FOUND`).
- Inviting the same email twice, with different casing, or an email that is already a member: no duplicate rows, no error (Task 3 tests).
- The owner tries to leave, demote themselves or be removed: refused with `FORBIDDEN` (Task 3 tests).
- A removed user reconnects: `board:join` is refused, the client shows "no access" instead of an empty board (Tasks 5 and 6 tests).
- A viewer's client tries to write anyway (stale UI, console): refused by the server and by the client engine, no optimistic change is shown (Tasks 2, 5, 6 tests).

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/shared/src/models.ts` | role, member, invite and board-with-role schemas and request bodies |
| `packages/shared/src/events.ts` | `FORBIDDEN` code, `role` in the join ack, `board:access` event, inter-server event type |
| `apps/server/src/migrations.ts` | migration 2: `board_members`, `board_invites`, owner backfill |
| `apps/server/src/roles.ts` | `roleOf(db, boardId, userId)`: the one role lookup, used by the service and gateway |
| `apps/server/src/boardService.ts` | `role()`, `listBoards(userId)`, owner row on create, role check in `commit()` |
| `apps/server/src/membership.ts` | `MembershipService`: list, add, set role, remove, remove invite |
| `apps/server/src/auth.ts` | `upsertUser` claims pending invites |
| `apps/server/src/app.ts` | REST member routes, membership check on board routes, `ServiceError` to HTTP mapping |
| `apps/server/src/gateway.ts` | join check, `role` in ack, `leaveBoard`, `applyAccessChange` |
| `apps/server/src/server.ts` | wires `MembershipService` to the gateway |
| `apps/web/src/api.ts` | member API calls, `BoardWithRole` |
| `apps/web/src/lib/boardClient.ts` | `role`, `board:access`, `removed` status, viewer write guard |
| `apps/web/src/components/ShareDialog.tsx` | new: member list, role select, invite form |
| `apps/web/src/components/{BoardView,Column,CardTile,CardModal,BoardPage,BoardsPage}.tsx` | viewer mode, Share button, removed screen, role badge |

---

### Task 1: Shared contracts

**Files:**
- Modify: `packages/shared/src/models.ts`, `packages/shared/src/events.ts`
- Test: `packages/shared/test/schemas.test.ts`

**Interfaces:**
- Produces (all exported from `@board/shared`):
  `roleSchema`, `type Role = 'owner'|'editor'|'viewer'`, `grantableRoleSchema`, `type GrantableRole = 'editor'|'viewer'`, `canWrite(role: Role | null): boolean`,
  `boardWithRoleSchema`, `type BoardWithRole = Board & { role: Role }`,
  `memberSchema`, `type Member = { userId; name; color; role: Role; email?: string }`,
  `inviteSchema`, `type Invite = { email: string; role: GrantableRole }`,
  `type MembersResponse = { members: Member[]; invites?: Invite[] }`,
  `type AddMemberResult = { member: Member } | { invite: Invite }`,
  `addMemberBody` (`{ email, role }`), `setRoleBody` (`{ role }`),
  `ERROR_CODES` now includes `'FORBIDDEN'`, `JoinAck` carries `role: Role`,
  `type AccessChange = { boardId: string; userId: string; role: Role | null }`,
  `interface InterServerEvents { 'access:changed': (c: AccessChange) => void }`,
  `ServerToClientEvents['board:access']: (p: { boardId: string; role: Role | null }) => void`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/test/schemas.test.ts` (add the new names to its existing import from `../src/index.js` or whichever path the file already uses):

```ts
describe('membership schemas', () => {
  it('only lets an owner grant editor or viewer, never owner', () => {
    expect(addMemberBody.safeParse({ email: 'a@example.test', role: 'editor' }).success).toBe(true);
    expect(addMemberBody.safeParse({ email: 'a@example.test', role: 'viewer' }).success).toBe(true);
    expect(addMemberBody.safeParse({ email: 'a@example.test', role: 'owner' }).success).toBe(false);
    expect(setRoleBody.safeParse({ role: 'owner' }).success).toBe(false);
  });

  it('rejects malformed or oversized emails', () => {
    expect(addMemberBody.safeParse({ email: 'not-an-email', role: 'editor' }).success).toBe(false);
    expect(addMemberBody.safeParse({ email: `${'a'.repeat(200)}@example.test`, role: 'editor' }).success).toBe(false);
  });

  it('knows which roles may write', () => {
    expect(canWrite('owner')).toBe(true);
    expect(canWrite('editor')).toBe(true);
    expect(canWrite('viewer')).toBe(false);
    expect(canWrite(null)).toBe(false);
  });

  it('has a FORBIDDEN error code', () => {
    expect(ERROR_CODES).toContain('FORBIDDEN');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit packages/shared/test/schemas.test.ts`
Expected: FAIL (`addMemberBody` / `canWrite` / `ERROR_CODES` not exported or `FORBIDDEN` missing).

- [ ] **Step 3: Implement**

In `packages/shared/src/models.ts`, after `boardSchema`/`Board`, add:

```ts
export const roleSchema = z.enum(['owner', 'editor', 'viewer']);
export type Role = z.infer<typeof roleSchema>;
/** Roles an owner can hand out. There is exactly one owner per board. */
export const grantableRoleSchema = z.enum(['editor', 'viewer']);
export type GrantableRole = z.infer<typeof grantableRoleSchema>;
export const canWrite = (role: Role | null): boolean => role === 'owner' || role === 'editor';

export const boardWithRoleSchema = boardSchema.extend({ role: roleSchema });
export type BoardWithRole = z.infer<typeof boardWithRoleSchema>;

export const memberSchema = z.object({
  userId: idSchema,
  name: z.string(),
  color: z.string(),
  role: roleSchema,
  /** Only sent to the board owner. */
  email: z.string().optional(),
});
export type Member = z.infer<typeof memberSchema>;

export const inviteSchema = z.object({ email: z.string(), role: grantableRoleSchema });
export type Invite = z.infer<typeof inviteSchema>;

export type MembersResponse = { members: Member[]; invites?: Invite[] };
export type AddMemberResult = { member: Member } | { invite: Invite };

export const addMemberBody = z.object({ email: z.email().max(200), role: grantableRoleSchema });
export const setRoleBody = z.object({ role: grantableRoleSchema });
```

In `packages/shared/src/events.ts`: import `roleSchema`, `type Role` from `./models.js`; add `'FORBIDDEN'` to `ERROR_CODES`; change `JoinAck` to
`Ack<JoinResult & { instance: string; presence: PresenceMember[]; role: Role }>`; add to `ServerToClientEvents`
`'board:access': (payload: { boardId: string; role: Role | null }) => void;`; and add:

```ts
export type AccessChange = { boardId: string; userId: string; role: Role | null };

/** Events instances send each other through the Redis adapter (`io.serverSideEmit`). */
export interface InterServerEvents {
  'access:changed': (change: AccessChange) => void;
}
```

(`roleSchema` is only needed if you reference it at runtime; import just `type Role` if Biome flags the value import as unused.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project unit packages/shared && npm run typecheck`
Expected: PASS. `typecheck` will report errors in `apps/server` (JoinAck now requires `role`) and is fixed in later tasks; for this task only require `packages/shared` to typecheck: `npx tsc -p packages/shared/tsconfig.json`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): roles, member and invite schemas, FORBIDDEN, board:access"
```

---

### Task 2: Migration, role lookup and enforcement in commands

**Files:**
- Create: `apps/server/src/roles.ts`, `apps/server/test/membership.int.test.ts`
- Modify: `apps/server/src/migrations.ts`, `apps/server/src/boardService.ts`, `apps/server/test/helpers.ts`, `apps/server/test/crossInstance.int.test.ts`, `apps/server/test/catchup.int.test.ts`, `apps/server/test/conflicts.int.test.ts`

**Interfaces:**
- Consumes: `Role`, `canWrite`, `BoardWithRole` from Task 1.
- Produces:
  `roleOf(db: Db, boardId: string, userId: string): Promise<Role | null>` and `type Db = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }` in `roles.ts`;
  `BoardService.role(boardId, userId): Promise<Role | null>`;
  `BoardService.listBoards(userId: string): Promise<BoardWithRole[]>`;
  `export const BACKFILL_OWNERS_SQL` in `migrations.ts`;
  test helper `world.newBoard(ownerId: string, editors?: string[])` adds each id in `editors` as an `editor` member.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/membership.int.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { keyBetween } from '@board/shared';
import { BACKFILL_OWNERS_SQL } from '../src/migrations.js';
import { createWorld } from './helpers.js';

const world = createWorld();
afterAll(() => world.close());

const addTo = (boardId: string, userId: string, role: 'editor' | 'viewer') =>
  world.pool.query('INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, $3)', [boardId, userId, role]);

const cardOn = (snap: Awaited<ReturnType<typeof world.newBoard>>) => ({
  id: randomUUID(),
  boardId: snap.board.id,
  columnId: snap.columns[0]!.id,
  title: 'Card',
  position: keyBetween(null, null),
});

describe('membership data and enforcement', () => {
  it('makes the creator the owner and filters boards by membership', async () => {
    const ada = await world.newUser('Ada');
    const grace = await world.newUser('Grace');
    const mine = await world.newBoard(ada.id);
    const hers = await world.newBoard(grace.id);

    expect(await world.service.role(mine.board.id, ada.id)).toBe('owner');
    expect(await world.service.role(mine.board.id, grace.id)).toBeNull();

    const adaBoards = await world.service.listBoards(ada.id);
    expect(adaBoards.map((b) => b.id)).toContain(mine.board.id);
    expect(adaBoards.map((b) => b.id)).not.toContain(hers.board.id);
    expect(adaBoards.find((b) => b.id === mine.board.id)?.role).toBe('owner');
  });

  it('backfills an owner row for boards that predate membership, and is safe to run twice', async () => {
    const ada = await world.newUser('Ada');
    const boardId = randomUUID();
    await world.pool.query('INSERT INTO boards (id, name, owner_id) VALUES ($1, $2, $3)', [boardId, 'Legacy', ada.id]);

    await world.pool.query(BACKFILL_OWNERS_SQL);
    await world.pool.query(BACKFILL_OWNERS_SQL);

    expect(await world.service.role(boardId, ada.id)).toBe('owner');
    const { rows } = await world.pool.query('SELECT count(*)::int AS n FROM board_members WHERE board_id = $1', [boardId]);
    expect(rows[0].n).toBe(1);
  });

  it('refuses commands from a non-member as if the board did not exist, writing nothing', async () => {
    const ada = await world.newUser('Ada');
    const stranger = await world.newUser('Stranger');
    const snap = await world.newBoard(ada.id);
    await expect(world.service.createCard(stranger.id, cardOn(snap))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await world.service.latestSeq(snap.board.id)).toBe(0);
  });

  it('refuses commands from a viewer with FORBIDDEN, writing nothing', async () => {
    const ada = await world.newUser('Ada');
    const vic = await world.newUser('Vic');
    const snap = await world.newBoard(ada.id);
    await addTo(snap.board.id, vic.id, 'viewer');
    await expect(world.service.createCard(vic.id, cardOn(snap))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await world.service.latestSeq(snap.board.id)).toBe(0);
  });

  it('lets editors write, and stops a member the moment they are removed', async () => {
    const ada = await world.newUser('Ada');
    const ed = await world.newUser('Ed');
    const snap = await world.newBoard(ada.id, [ed.id]);
    await expect(world.service.createCard(ed.id, cardOn(snap))).resolves.toMatchObject({ seq: 1 });

    await world.pool.query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [snap.board.id, ed.id]);
    await expect(world.service.createCard(ed.id, cardOn(snap))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await world.service.latestSeq(snap.board.id)).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project integration apps/server/test/membership.int.test.ts`
Expected: FAIL (`BACKFILL_OWNERS_SQL` is not exported / `world.service.role` is not a function).

- [ ] **Step 3: Implement**

`apps/server/src/roles.ts`:

```ts
import type { Role } from '@board/shared';

/** Anything with pg's `query`: a Pool or a PoolClient inside a transaction. */
export type Db = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

/** The user's role on the board, or null if they are not a member. */
export async function roleOf(db: Db, boardId: string, userId: string): Promise<Role | null> {
  const { rows } = await db.query('SELECT role FROM board_members WHERE board_id = $1 AND user_id = $2', [boardId, userId]);
  return (rows[0]?.role as Role | undefined) ?? null;
}
```

`apps/server/src/migrations.ts`: above the array add

```ts
/** Gives every board that has an owner_id a matching owner member. Idempotent. */
export const BACKFILL_OWNERS_SQL = `
  INSERT INTO board_members (board_id, user_id, role)
  SELECT id, owner_id, 'owner' FROM boards WHERE owner_id IS NOT NULL
  ON CONFLICT (board_id, user_id) DO NOTHING;
`;
```

and append a second migration to the array:

```ts
  {
    id: 2,
    name: 'board membership',
    sql: `
      CREATE TABLE board_members (
        board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role       text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (board_id, user_id)
      );
      CREATE INDEX board_members_user_idx ON board_members (user_id);
      CREATE UNIQUE INDEX board_members_one_owner ON board_members (board_id) WHERE role = 'owner';

      CREATE TABLE board_invites (
        board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        email      text NOT NULL,
        role       text NOT NULL CHECK (role IN ('editor', 'viewer')),
        invited_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (board_id, email)
      );

      ${BACKFILL_OWNERS_SQL}
    `,
  },
```

`apps/server/src/boardService.ts`:
- import `canWrite`, `type BoardWithRole`, `type Role` from `@board/shared`, and `roleOf` from `./roles.js`.
- Replace `listBoards`:

```ts
  async listBoards(userId: string): Promise<BoardWithRole[]> {
    const { rows } = await this.pool.query(
      `SELECT b.id, b.name, b.created_at, m.role
         FROM boards b JOIN board_members m ON m.board_id = b.id
        WHERE m.user_id = $1 ORDER BY b.created_at DESC LIMIT 100`,
      [userId],
    );
    return rows.map((r) => ({ ...toBoard(r), role: r.role as Role }));
  }

  async role(boardId: string, userId: string): Promise<Role | null> {
    return roleOf(this.pool, boardId, userId);
  }
```

- In `createBoard`, right after the `INSERT INTO boards` query add:
  `await client.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'owner')", [id, ownerId]);`
- In `commit()`, immediately after `const current = lock.rows[0].last_seq as number;` add:

```ts
      // Read inside the lock: a removal committed before this point is always seen.
      const role = await roleOf(client, boardId, actorId);
      if (!role) throw new ServiceError('NOT_FOUND', 'Board not found');
      if (!canWrite(role)) throw new ServiceError('FORBIDDEN', 'You have view-only access to this board');
```

`apps/server/test/helpers.ts`: change `newBoard` in the `TestWorld` interface to `newBoard: (ownerId: string, editors?: string[]) => Promise<BoardSnapshot>;` and its implementation to:

```ts
    async newBoard(ownerId, editors = []) {
      const snap = await service.createBoard(ownerId, `Board ${randomUUID().slice(0, 6)}`);
      for (const userId of editors) {
        await pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'editor')", [snap.board.id, userId]);
      }
      return snap;
    },
```

Existing tests where a second user opens the owner's board need membership: change `world.newBoard(ada.id)` to `world.newBoard(ada.id, [grace.id])` at `crossInstance.int.test.ts` lines 23, 45, 76; `catchup.int.test.ts` line 22; `conflicts.int.test.ts` lines 23, 118. Update `apps/server/src/app.ts` `GET /boards` to `service.listBoards(req.userId!)` so the project compiles (the route is reworked in Task 4).

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:integration`
Expected: PASS for all files (new membership tests plus the existing suites). If another existing test has a non-owner opening a board, add them via `newBoard(owner, [id])` the same way.

- [ ] **Step 5: Commit**

```bash
git add apps/server packages
git commit -m "feat(server): board_members migration and role enforcement in commands"
```

---

### Task 3: MembershipService and invite claiming

**Files:**
- Create: `apps/server/src/membership.ts`, `apps/server/test/members.int.test.ts`
- Modify: `apps/server/src/auth.ts`

**Interfaces:**
- Consumes: `roleOf` (Task 2), shared types (Task 1), `ServiceError`.
- Produces:

```ts
export class MembershipService {
  constructor(pool: Pool, onAccessChanged: (change: AccessChange) => void);
  listMembers(boardId: string, actorId: string): Promise<MembersResponse>;
  addMember(boardId: string, actorId: string, email: string, role: GrantableRole): Promise<AddMemberResult>;
  setRole(boardId: string, actorId: string, userId: string, role: GrantableRole): Promise<void>;
  removeMember(boardId: string, actorId: string, userId: string): Promise<void>;
  removeInvite(boardId: string, actorId: string, email: string): Promise<void>;
}
```

`upsertUser` keeps its signature and now claims invites.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/members.int.test.ts`:

```ts
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

async function boardWith(roles: { editor?: boolean; viewer?: boolean } = {}) {
  const owner = await world.newUser('Owner');
  const editor = await world.newUser('Ed');
  const viewer = await world.newUser('Vic');
  const outsider = await world.newUser('Outsider');
  const snap = await world.newBoard(owner.id, roles.editor === false ? [] : [editor.id]);
  if (roles.viewer !== false) {
    await world.pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'viewer')", [snap.board.id, viewer.id]);
  }
  return { owner, editor, viewer, outsider, boardId: snap.board.id };
}

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
    const user = await world.pool.query('SELECT email FROM users WHERE id = $1', [outsider.id]);
    const result = await members.addMember(boardId, owner.id, user.rows[0].email, 'editor');
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
    const rows = await world.pool.query('SELECT id, email FROM users WHERE id = ANY($1)', [[owner.id, editor.id]]);
    const emailOf = (id: string) => rows.rows.find((r) => r.id === id).email as string;

    const again = await members.addMember(boardId, owner.id, emailOf(editor.id), 'viewer');
    expect(again).toMatchObject({ member: { userId: editor.id, role: 'editor' } }); // role unchanged
    const self = await members.addMember(boardId, owner.id, emailOf(owner.id), 'viewer');
    expect(self).toMatchObject({ member: { userId: owner.id, role: 'owner' } });
  });

  it('only the owner can invite', async () => {
    const { members } = setup();
    const { editor, viewer, outsider, boardId } = await boardWith();
    await expect(members.addMember(boardId, editor.id, email(), 'viewer')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(members.addMember(boardId, viewer.id, email(), 'viewer')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(members.addMember(boardId, outsider.id, email(), 'viewer')).rejects.toMatchObject({ code: 'NOT_FOUND' });
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
    await expect(members.setRole(boardId, owner.id, owner.id, 'viewer')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(members.removeMember(boardId, owner.id, owner.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await world.service.role(boardId, owner.id)).toBe('owner');
  });

  it('only the owner changes roles or removes others', async () => {
    const { members } = setup();
    const { editor, viewer, boardId } = await boardWith();
    await expect(members.setRole(boardId, editor.id, viewer.id, 'editor')).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
    await expect(members.setRole(boardId, owner.id, outsider.id, 'viewer')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('notifications', () => {
  it('does not notify when nothing changed', async () => {
    const onChange = vi.fn();
    const members = new MembershipService(world.pool, onChange);
    const { owner, editor, boardId } = await boardWith();
    const row = await world.pool.query('SELECT email FROM users WHERE id = $1', [editor.id]);
    await members.addMember(boardId, owner.id, row.rows[0].email, 'viewer');
    expect(onChange).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project integration apps/server/test/members.int.test.ts`
Expected: FAIL (`../src/membership.js` cannot be resolved).

- [ ] **Step 3: Implement**

`apps/server/src/membership.ts`:

```ts
import type {
  AccessChange,
  AddMemberResult,
  GrantableRole,
  Invite,
  Member,
  MembersResponse,
  Role,
} from '@board/shared';
import type { Pool } from './db.js';
import { ServiceError } from './errors.js';
import { roleOf } from './roles.js';

const ROLE_ORDER = `CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END`;

/** Who is on a board and what they may do. Role checks for commands live in BoardService.commit(). */
export class MembershipService {
  constructor(
    private readonly pool: Pool,
    private readonly onAccessChanged: (change: AccessChange) => void,
  ) {}

  /** The actor's role; a non-member sees the same "not found" as for a board that does not exist. */
  private async requireRole(boardId: string, actorId: string): Promise<Role> {
    const role = await roleOf(this.pool, boardId, actorId);
    if (!role) throw new ServiceError('NOT_FOUND', 'Board not found');
    return role;
  }

  private async requireOwner(boardId: string, actorId: string): Promise<void> {
    if ((await this.requireRole(boardId, actorId)) !== 'owner') {
      throw new ServiceError('FORBIDDEN', 'Only the board owner can do that');
    }
  }

  async listMembers(boardId: string, actorId: string): Promise<MembersResponse> {
    const actor = await this.requireRole(boardId, actorId);
    const { rows } = await this.pool.query(
      `SELECT m.user_id, m.role, u.name, u.color, u.email
         FROM board_members m JOIN users u ON u.id = m.user_id
        WHERE m.board_id = $1 ORDER BY ${ROLE_ORDER}, u.name`,
      [boardId],
    );
    const members: Member[] = rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      color: r.color,
      role: r.role,
      ...(actor === 'owner' && { email: r.email }),
    }));
    if (actor !== 'owner') return { members };
    const invites = await this.pool.query(
      'SELECT email, role FROM board_invites WHERE board_id = $1 ORDER BY created_at, email',
      [boardId],
    );
    return { members, invites: invites.rows.map((r): Invite => ({ email: r.email, role: r.role })) };
  }

  async addMember(boardId: string, actorId: string, email: string, role: GrantableRole): Promise<AddMemberResult> {
    await this.requireOwner(boardId, actorId);
    const normalized = email.trim().toLowerCase();

    const found = await this.pool.query('SELECT id, name, color, email FROM users WHERE email = $1', [normalized]);
    const user = found.rows[0];
    if (user) {
      await this.pool.query(
        `INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (board_id, user_id) DO NOTHING`,
        [boardId, user.id, role],
      );
      await this.pool.query('DELETE FROM board_invites WHERE board_id = $1 AND email = $2', [boardId, normalized]);
      const current = (await roleOf(this.pool, boardId, user.id)) as Role;
      return { member: { userId: user.id, name: user.name, color: user.color, role: current, email: user.email } };
    }

    await this.pool.query(
      `INSERT INTO board_invites (board_id, email, role, invited_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (board_id, email) DO UPDATE SET role = EXCLUDED.role`,
      [boardId, normalized, role, actorId],
    );
    return { invite: { email: normalized, role } };
  }

  async setRole(boardId: string, actorId: string, userId: string, role: GrantableRole): Promise<void> {
    await this.requireOwner(boardId, actorId);
    const current = await roleOf(this.pool, boardId, userId);
    if (!current) throw new ServiceError('NOT_FOUND', 'That person is not on this board');
    if (current === 'owner') throw new ServiceError('FORBIDDEN', 'The owner role cannot be changed');
    await this.pool.query('UPDATE board_members SET role = $3 WHERE board_id = $1 AND user_id = $2', [
      boardId,
      userId,
      role,
    ]);
    if (current !== role) this.onAccessChanged({ boardId, userId, role });
  }

  /** The owner can remove anyone but themselves; every other member can remove only themselves (leave). */
  async removeMember(boardId: string, actorId: string, userId: string): Promise<void> {
    const actor = await this.requireRole(boardId, actorId);
    if (actorId !== userId && actor !== 'owner') {
      throw new ServiceError('FORBIDDEN', 'Only the board owner can remove other people');
    }
    const target = await roleOf(this.pool, boardId, userId);
    if (!target) throw new ServiceError('NOT_FOUND', 'That person is not on this board');
    if (target === 'owner') throw new ServiceError('FORBIDDEN', 'The owner cannot be removed from their board');
    await this.pool.query('DELETE FROM board_members WHERE board_id = $1 AND user_id = $2', [boardId, userId]);
    this.onAccessChanged({ boardId, userId, role: null });
  }

  async removeInvite(boardId: string, actorId: string, email: string): Promise<void> {
    await this.requireOwner(boardId, actorId);
    await this.pool.query('DELETE FROM board_invites WHERE board_id = $1 AND email = $2', [
      boardId,
      email.trim().toLowerCase(),
    ]);
  }
}
```

`apps/server/src/auth.ts`: in `upsertUser`, replace `return rows[0]!;` with

```ts
  const user = rows[0]!;
  // Pending invites for this address become memberships. Every sign-in path goes through here.
  await pool.query(
    `WITH claimed AS (DELETE FROM board_invites WHERE email = $1 RETURNING board_id, role)
     INSERT INTO board_members (board_id, user_id, role)
     SELECT board_id, $2, role FROM claimed
     ON CONFLICT (board_id, user_id) DO NOTHING`,
    [normalized, user.id],
  );
  return user;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project integration apps/server/test/members.int.test.ts && npm run typecheck`
Expected: PASS. (`typecheck` may still fail in `gateway.ts` because of `JoinAck.role` until Task 5; run `npx tsc -p apps/server/tsconfig.json` and confirm the only errors are about `role` in `gateway.ts`.)

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): MembershipService with invites, roles, removal and sign-in claiming"
```

---

### Task 4: REST routes

**Files:**
- Modify: `apps/server/src/app.ts`, `apps/server/src/server.ts`
- Create: `apps/server/test/members.rest.int.test.ts`
- Modify: `apps/server/test/auth.int.test.ts` only if it breaks (it should not)

**Interfaces:**
- Consumes: `MembershipService` (Task 3), `BoardService.role/listBoards` (Task 2), `addMemberBody`, `setRoleBody`.
- Produces: `createApp` deps gain `membership: MembershipService`. Routes and bodies exactly as the spec's REST table. Delete routes answer `{ ok: true }`. `ServiceError` maps to HTTP: `NOT_FOUND` 404, `FORBIDDEN` 403, `VALIDATION` 400, anything else 500.
- `server.ts` creates the `MembershipService` with a late-bound callback (`let notifyAccess`), filled in by Task 5.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/members.rest.int.test.ts`:

```ts
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
    headers: { authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  });

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
    const mine = (await (await call(owner.token, 'GET', '/api/boards')).json()) as { boards: { id: string; role: string }[] };
    expect(mine.boards.find((b) => b.id === id)?.role).toBe('owner');
    const eds = (await (await call(editor.token, 'GET', '/api/boards')).json()) as { boards: { id: string; role: string }[] };
    expect(eds.boards.find((b) => b.id === id)?.role).toBe('editor');
    const theirs = (await (await call(outsider.token, 'GET', '/api/boards')).json()) as { boards: { id: string }[] };
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

    const invite = await call(owner.token, 'POST', `/api/boards/${id}/members`, { email: 'Guest@Example.test', role: 'viewer' });
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

    expect((await call(owner.token, 'PATCH', `/api/boards/${id}/members/${editor.id}`, { role: 'viewer' })).status).toBe(200);
    expect((await call(owner.token, 'DELETE', `/api/boards/${id}/invites/${encodeURIComponent('guest@example.test')}`)).status).toBe(200);
    expect((await call(owner.token, 'DELETE', `/api/boards/${id}/members/${editor.id}`)).status).toBe(200);
    expect((await call(editor.token, 'GET', `/api/boards/${id}`)).status).toBe(404);
  });

  it('answers 403 to a member who is not the owner and 404 to a stranger', async () => {
    const { editor, outsider, owner, id } = await scene();
    const body = { email: 'x@example.test', role: 'viewer' };
    expect((await call(editor.token, 'POST', `/api/boards/${id}/members`, body)).status).toBe(403);
    expect((await call(outsider.token, 'POST', `/api/boards/${id}/members`, body)).status).toBe(404);
    expect((await call(editor.token, 'PATCH', `/api/boards/${id}/members/${owner.id}`, { role: 'viewer' })).status).toBe(403);
    expect((await call(editor.token, 'DELETE', `/api/boards/${id}/members/${owner.id}`)).status).toBe(403);
  });

  it('protects the owner row and lets an editor leave', async () => {
    const { owner, editor, id } = await scene();
    expect((await call(owner.token, 'PATCH', `/api/boards/${id}/members/${owner.id}`, { role: 'viewer' })).status).toBe(403);
    expect((await call(owner.token, 'DELETE', `/api/boards/${id}/members/${owner.id}`)).status).toBe(403);
    expect((await call(editor.token, 'DELETE', `/api/boards/${id}/members/${editor.id}`)).status).toBe(200);
  });

  it('rejects an owner role in the body and a malformed email with 400', async () => {
    const { owner, id } = await scene();
    expect((await call(owner.token, 'POST', `/api/boards/${id}/members`, { email: 'x@example.test', role: 'owner' })).status).toBe(400);
    expect((await call(owner.token, 'POST', `/api/boards/${id}/members`, { email: 'nope', role: 'editor' })).status).toBe(400);
    expect((await call(owner.token, 'GET', '/api/boards/not-a-uuid/members')).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project integration apps/server/test/members.rest.int.test.ts`
Expected: FAIL (outsider gets 200 on the board, member routes 404).

- [ ] **Step 3: Implement**

`apps/server/src/app.ts`:
- imports: add `addMemberBody, setRoleBody, type ErrorCode` from `@board/shared`; `import { ServiceError } from './errors.js'`; `import type { MembershipService } from './membership.js'`.
- `Deps` gains `membership: MembershipService;` and `createApp` destructures it.
- Above the routes add:

```ts
  type AuthedRequest = Request & { userId?: string };
  /** Non-members get the same 404 as for a board that does not exist. */
  const mustBeMember = async (boardId: string, userId: string) => {
    if (!(await service.role(boardId, userId))) throw new HttpError(404, 'Board not found');
  };
```

- Replace the board routes with:

```ts
  api.get('/boards', async (req: AuthedRequest, res) => {
    res.json({ boards: await service.listBoards(req.userId!) });
  });

  api.post('/boards', async (req: AuthedRequest, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(LIMITS.boardName) }).parse(req.body);
    res.status(201).json(await service.createBoard(req.userId!, name));
  });

  api.get('/boards/:id', async (req: AuthedRequest, res) => {
    const id = z.uuid().parse(req.params.id);
    await mustBeMember(id, req.userId!);
    const snapshot = await service.getSnapshot(id);
    if (!snapshot) throw new HttpError(404, 'Board not found');
    res.json(snapshot);
  });

  api.get('/boards/:id/events', async (req: AuthedRequest, res) => {
    const id = z.uuid().parse(req.params.id);
    await mustBeMember(id, req.userId!);
    const after = z.coerce.number().int().min(0).default(0).parse(req.query.after);
    res.json({ events: await service.eventsSince(id, after, 500) });
  });

  api.get('/boards/:id/members', async (req: AuthedRequest, res) => {
    const id = z.uuid().parse(req.params.id);
    res.json(await membership.listMembers(id, req.userId!));
  });

  api.post('/boards/:id/members', async (req: AuthedRequest, res) => {
    const id = z.uuid().parse(req.params.id);
    const { email, role } = addMemberBody.parse(req.body);
    res.json(await membership.addMember(id, req.userId!, email, role));
  });

  api.patch('/boards/:id/members/:userId', async (req: AuthedRequest, res) => {
    const id = z.uuid().parse(req.params.id);
    const userId = z.uuid().parse(req.params.userId);
    const { role } = setRoleBody.parse(req.body);
    await membership.setRole(id, req.userId!, userId, role);
    res.json({ ok: true });
  });

  api.delete('/boards/:id/members/:userId', async (req: AuthedRequest, res) => {
    const id = z.uuid().parse(req.params.id);
    const userId = z.uuid().parse(req.params.userId);
    await membership.removeMember(id, req.userId!, userId);
    res.json({ ok: true });
  });

  api.delete('/boards/:id/invites/:email', async (req: AuthedRequest, res) => {
    const id = z.uuid().parse(req.params.id);
    const email = z.email().parse(req.params.email);
    await membership.removeInvite(id, req.userId!, email);
    res.json({ ok: true });
  });
```

- In the error handler add, before the `ZodError` branch:

```ts
    if (err instanceof ServiceError) {
      const status: Partial<Record<ErrorCode, number>> = { NOT_FOUND: 404, FORBIDDEN: 403, VALIDATION: 400 };
      return void res.status(status[err.code] ?? 500).json({ error: err.message });
    }
```

`apps/server/src/server.ts`: import `MembershipService` and `type AccessChange`; after `const service = new BoardService(pool);` add

```ts
  // The gateway is attached after the app exists, so the callback is bound late.
  let notifyAccess: (change: AccessChange) => void = () => {};
  const membership = new MembershipService(pool, (change) => notifyAccess(change));
```

pass `membership` to `createApp({ config, pool, redis, service, membership, log })`. (Task 5 assigns `notifyAccess = gateway.applyAccessChange`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project integration apps/server/test/members.rest.int.test.ts apps/server/test/auth.int.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): member REST routes and membership check on board routes"
```

---

### Task 5: Gateway enforcement and live revocation

**Files:**
- Modify: `apps/server/src/gateway.ts`, `apps/server/src/server.ts`, `apps/server/test/helpers.ts`
- Create: `apps/server/test/access.int.test.ts`

**Interfaces:**
- Consumes: `BoardService.role`, `InterServerEvents`, `AccessChange`, `JoinAck.role`.
- Produces: `attachGateway(...)` returns `{ stop(): void; applyAccessChange(change: AccessChange): void }`; `BoardServer` is `Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>`; test helper `waitFor(socket, event, predicate?, ms?)`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/test/helpers.ts`:

```ts
/** Resolves with the first payload of `event` that satisfies `predicate`, or rejects after `ms`. */
export function waitFor<E extends keyof ServerToClientEvents>(
  socket: ClientSocket,
  event: E,
  predicate: (payload: Parameters<ServerToClientEvents[E]>[0]) => boolean = () => true,
  ms = 5000,
): Promise<Parameters<ServerToClientEvents[E]>[0]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${String(event)}`)), ms);
    const handler = (payload: any) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      (socket as any).off(event, handler);
      resolve(payload);
    };
    (socket as any).on(event, handler);
  });
}
```

Create `apps/server/test/access.int.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyBetween } from '@board/shared';
import type { ServerInstance } from '../src/server.js';
import { collectEvents, createWorld, emit, join, startPair, waitFor, type TestWorld } from './helpers.js';

describe('socket access control across two instances', () => {
  const world: TestWorld = createWorld();
  let a: ServerInstance;
  let b: ServerInstance;
  beforeAll(async () => {
    [a, b] = await startPair('access-a', 'access-b');
  });
  afterAll(async () => {
    await world.close();
    await Promise.all([a.close(), b.close()]);
  });

  const rest = (port: number, token: string, method: string, path: string, body?: unknown) =>
    fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body && { 'content-type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
    });

  const newCard = (boardId: string, columnId: string) => ({
    id: randomUUID(),
    boardId,
    columnId,
    title: 'Card',
    position: keyBetween(null, null),
  });

  it('refuses a non-member join like a missing board, and reports the role on a successful join', async () => {
    const ada = await world.newUser('Ada');
    const stranger = await world.newUser('Stranger');
    const snap = await world.newBoard(ada.id);

    const s = await world.connect(a.port, stranger.token);
    expect(await join(s, snap.board.id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await emit(s, 'card:create', newCard(snap.board.id, snap.columns[0]!.id))).toMatchObject({
      ok: false,
      code: 'NOT_JOINED',
    });

    const owner = await world.connect(b.port, ada.token);
    expect(await join(owner, snap.board.id)).toMatchObject({ ok: true, role: 'owner' });
  });

  it('lets a viewer read and appear in presence but refuses every write without broadcasting', async () => {
    const ada = await world.newUser('Ada');
    const vic = await world.newUser('Vic');
    const snap = await world.newBoard(ada.id);
    await world.pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'viewer')", [snap.board.id, vic.id]);

    const sv = await world.connect(a.port, vic.token);
    const so = await world.connect(b.port, ada.token);
    expect(await join(sv, snap.board.id)).toMatchObject({ ok: true, role: 'viewer' });
    await join(so, snap.board.id);
    const seen = collectEvents(so);

    const refused = await emit(sv, 'card:create', newCard(snap.board.id, snap.columns[0]!.id));
    expect(refused).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toHaveLength(0);
    expect(await world.service.latestSeq(snap.board.id)).toBe(0);
  });

  it('downgrades a live editor on the other instance to viewer', async () => {
    const ada = await world.newUser('Ada');
    const ed = await world.newUser('Ed');
    const snap = await world.newBoard(ada.id, [ed.id]);
    const se = await world.connect(b.port, ed.token);
    await join(se, snap.board.id);
    expect(await emit(se, 'card:create', newCard(snap.board.id, snap.columns[0]!.id))).toMatchObject({ ok: true });

    const access = waitFor(se, 'board:access', (p) => p.boardId === snap.board.id);
    const res = await rest(a.port, ada.token, 'PATCH', `/api/boards/${snap.board.id}/members/${ed.id}`, { role: 'viewer' });
    expect(res.status).toBe(200);
    expect(await access).toEqual({ boardId: snap.board.id, role: 'viewer' });

    expect(await emit(se, 'card:create', newCard(snap.board.id, snap.columns[0]!.id))).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('removes a live member on the other instance: no more events, gone from presence, join refused', async () => {
    const ada = await world.newUser('Ada');
    const ed = await world.newUser('Ed');
    const snap = await world.newBoard(ada.id, [ed.id]);
    const se = await world.connect(b.port, ed.token);
    const so = await world.connect(a.port, ada.token);
    await join(se, snap.board.id);
    await join(so, snap.board.id);
    const edEvents = collectEvents(se);

    const access = waitFor(se, 'board:access', (p) => p.boardId === snap.board.id);
    const roster = waitFor(so, 'presence:update', (p) => p.boardId === snap.board.id && !p.members.some((m) => m.user.id === ed.id));
    const res = await rest(a.port, ada.token, 'DELETE', `/api/boards/${snap.board.id}/members/${ed.id}`);
    expect(res.status).toBe(200);
    expect(await access).toEqual({ boardId: snap.board.id, role: null });
    await roster;

    await emit(so, 'card:create', newCard(snap.board.id, snap.columns[0]!.id));
    await new Promise((r) => setTimeout(r, 300));
    expect(edEvents).toHaveLength(0);

    expect(await emit(se, 'card:create', newCard(snap.board.id, snap.columns[0]!.id))).toMatchObject({
      ok: false,
      code: 'NOT_JOINED',
    });
    expect(await join(se, snap.board.id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project integration apps/server/test/access.int.test.ts`
Expected: FAIL (non-member join succeeds; no `role` in the ack; no `board:access`).

- [ ] **Step 3: Implement**

`apps/server/src/gateway.ts`:
- imports: add `type AccessChange`, `type InterServerEvents` from `@board/shared`.
- `BoardServer`/`BoardSocket` types use `InterServerEvents` as the third generic instead of `Record<string, never>`.
- Move `leave` out of the connection handler to `attachGateway` scope, next to `broadcastPresence`:

```ts
  async function leaveBoard(socket: BoardSocket, boardId: string): Promise<void> {
    if (!socket.data.boards.delete(boardId)) return;
    await socket.leave(roomOf(boardId));
    await presence.leave(boardId, socket.id);
    await broadcastPresence(boardId);
  }
```

  and make the `board:leave` handler and the `disconnect` handler call `leaveBoard(socket, boardId)`. Delete the old inner `leave`.
- In the `board:join` handler, first thing inside it:

```ts
        const role = await service.role(boardId, user.id);
        if (!role) throw new ServiceError('NOT_FOUND', 'Board not found');
```

  keep the existing `latestSeq` null check after it, and return `{ ...result, instance, presence: members, role }`.
- Add, below `leaveBoard`:

```ts
  /** Applies a role change to this instance's sockets: removed users leave the room, everyone is told. */
  async function applyAccessLocal({ boardId, userId, role }: AccessChange): Promise<void> {
    for (const s of io.sockets.sockets.values()) {
      const socket = s as BoardSocket;
      if (socket.data.user?.id !== userId || !socket.data.boards?.has(boardId)) continue;
      if (role === null) await leaveBoard(socket, boardId);
      socket.emit('board:access', { boardId, role });
    }
  }
  const applyLocally = (change: AccessChange) =>
    void applyAccessLocal(change).catch((err) => log(`[${instance}] access change failed: ${String(err)}`));

  // Other instances announce changes made through their REST routes.
  io.on('access:changed', applyLocally);
  const applyAccessChange = (change: AccessChange) => {
    applyLocally(change);
    io.serverSideEmit('access:changed', change);
  };
```

- return `{ stop: () => clearInterval(timer), applyAccessChange }` and widen the declared return type to `{ stop: () => void; applyAccessChange: (change: AccessChange) => void }`.

`apps/server/src/server.ts`: import `type InterServerEvents`; use `Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>`; after `const gateway = attachGateway(...)` add `notifyAccess = gateway.applyAccessChange;`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run typecheck && npm run test:integration`
Expected: PASS (typecheck is fully clean again).

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): enforce roles on join and push access changes to live sockets"
```

---

### Task 6: Client engine and API

**Files:**
- Modify: `apps/web/src/api.ts`, `apps/web/src/lib/boardClient.ts`, `apps/web/test/boardClient.test.ts`

**Interfaces:**
- Consumes: shared `Role`, `BoardWithRole`, `MembersResponse`, `AddMemberResult`, `GrantableRole`.
- Produces: `BoardViewModel.role: Role | null`; `ConnectionStatus` gains `'removed'`; api functions
  `listBoards(): Promise<{ boards: BoardWithRole[] }>`,
  `listMembers(boardId): Promise<MembersResponse>`,
  `addMember(boardId, email, role): Promise<AddMemberResult>`,
  `setMemberRole(boardId, userId, role): Promise<{ ok: true }>`,
  `removeMember(boardId, userId): Promise<{ ok: true }>`,
  `removeInvite(boardId, email): Promise<{ ok: true }>`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/boardClient.test.ts` change `setup` to accept a role and include it in the ack:

```ts
async function setup(seq = 3, role: 'owner' | 'editor' | 'viewer' = 'editor') {
  const socket = new FakeSocket();
  const client = new BoardClient(socket as unknown as BoardSocket, BOARD, ME);
  const join = socket.last('board:join');
  join.ack!(null, { ok: true, mode: 'snapshot', snapshot: snapshot(seq), instance: 'server-1', presence: [], role });
  await vi.advanceTimersByTimeAsync(0);
  return { socket, client };
}
```

Add a `describe('roles', ...)` block inside the file:

```ts
describe('roles', () => {
  it('remembers the role from the join ack', async () => {
    const { client } = await setup(3, 'viewer');
    expect(client.getSnapshot().role).toBe('viewer');
  });

  it('refuses writes from a viewer without touching the board or the network', async () => {
    const { socket, client } = await setup(3, 'viewer');
    const notices: { kind: string; message: string }[] = [];
    client.onNotice((n) => notices.push(n));
    client.createCard(COL_A, 'Nope');
    client.moveCard(uid(101), COL_B, 0);
    client.deleteCard(uid(101));
    expect(Object.keys(client.getSnapshot().state!.cards)).toHaveLength(2);
    expect(socket.count('card:create') + socket.count('card:move') + socket.count('card:delete')).toBe(0);
    expect(notices.every((n) => n.kind === 'error' && /view-only/i.test(n.message))).toBe(true);
    expect(notices).toHaveLength(3);
  });

  it('follows a live role change from the server', async () => {
    const { socket, client } = await setup(3, 'editor');
    socket.fire('board:access', { boardId: BOARD, role: 'viewer' });
    expect(client.getSnapshot().role).toBe('viewer');
    socket.fire('board:access', { boardId: BOARD, role: 'editor' });
    expect(client.getSnapshot().role).toBe('editor');
  });

  it('ignores access changes for another board', async () => {
    const { socket, client } = await setup(3, 'editor');
    socket.fire('board:access', { boardId: uid(77), role: null });
    expect(client.getSnapshot().status).toBe('live');
    expect(client.getSnapshot().role).toBe('editor');
  });

  it('marks the board as removed when access is revoked and discards unsent changes', async () => {
    const { socket, client } = await setup(3, 'editor');
    client.createCard(COL_A, 'In flight');
    socket.fire('board:access', { boardId: BOARD, role: null });
    const m = client.getSnapshot();
    expect(m.status).toBe('removed');
    expect(m.role).toBeNull();
    expect(Object.keys(m.state!.cards)).toHaveLength(2); // the optimistic card is gone
  });

  it('shows "removed" when rejoining a board it no longer has access to', async () => {
    const { socket, client } = await setup(3, 'editor');
    socket.fire('disconnect');
    socket.fire('connect');
    socket.last('board:join').ack!(null, { ok: false, code: 'NOT_FOUND', message: 'Board not found' });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getSnapshot().status).toBe('removed');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit apps/web/test/boardClient.test.ts`
Expected: FAIL (`role` is undefined; no `board:access` handling).

- [ ] **Step 3: Implement**

`apps/web/src/lib/boardClient.ts`:
- import `type Role` from `@board/shared`.
- `ConnectionStatus` becomes `'connecting' | 'live' | 'reconnecting' | 'unauthorized' | 'removed'`.
- `BoardViewModel` gains `role: Role | null;` and the initial `model` gains `role: null`.
- In the constructor, after the `presence:cursor` handler add:

```ts
    socket.on('board:access', (p) => {
      if (p.boardId !== this.boardId) return;
      if (p.role === null) {
        this.pending = [];
        this.chains.clear();
        this.update({ status: 'removed', role: null });
        return;
      }
      this.update({ role: p.role });
    });
```

- In `join()`, replace the `if (!ack.ok) {...}` block with:

```ts
    if (!ack.ok) {
      if (ack.code === 'NOT_FOUND') this.update({ status: 'removed', role: null });
      else this.notice('error', ack.message);
      return;
    }
```

  and the success update with `this.update({ status: 'live', instance: ack.instance, presence: ack.presence, role: ack.role });`.
- In `submit()`, after the existing `if (!this.joined || !this.auth)` guard add:

```ts
    if (this.model.role === 'viewer') {
      this.notice('error', 'You have view-only access to this board.');
      return;
    }
```

`apps/web/src/api.ts`: import `type AddMemberResult, type BoardWithRole, type GrantableRole, type MembersResponse` from `@board/shared`; let `request` accept `method` explicitly (it already reads `init.method`); replace `listBoards` and add:

```ts
  listBoards: () => request<{ boards: BoardWithRole[] }>('/api/boards'),
  listMembers: (boardId: string) => request<MembersResponse>(`/api/boards/${boardId}/members`),
  addMember: (boardId: string, email: string, role: GrantableRole) =>
    request<AddMemberResult>(`/api/boards/${boardId}/members`, { body: { email, role } }),
  setMemberRole: (boardId: string, userId: string, role: GrantableRole) =>
    request<{ ok: true }>(`/api/boards/${boardId}/members/${userId}`, { method: 'PATCH', body: { role } }),
  removeMember: (boardId: string, userId: string) =>
    request<{ ok: true }>(`/api/boards/${boardId}/members/${userId}`, { method: 'DELETE' }),
  removeInvite: (boardId: string, email: string) =>
    request<{ ok: true }>(`/api/boards/${boardId}/invites/${encodeURIComponent(email)}`, { method: 'DELETE' }),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project unit && npm run typecheck`
Expected: PASS (web typecheck may flag `BoardsPage` using `Board` from `listBoards`; `BoardWithRole` extends `Board`, so it should compile).

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): role and removed state in the sync engine, member API calls"
```

---

### Task 7: Share dialog and viewer mode

**Files:**
- Create: `apps/web/src/components/ShareDialog.tsx`
- Modify: `apps/web/src/components/{BoardView,Column,CardTile,CardModal,BoardPage,BoardsPage}.tsx`, `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `api.*` member calls and `vm.role` (Task 6).
- Produces: `ShareDialog({ boardId, role, selfUserId, onClose })`; `readOnly: boolean` props on `Column`, `CardTile`, `CardModal`. UI is verified by the e2e tests in Task 8 (the repo has no component test harness; adding one is a separate Phase 4 task).

- [ ] **Step 1: Implement `ShareDialog.tsx`**

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { GrantableRole, Invite, Member, Role } from '@board/shared';
import { api } from '../api';
import { navigate } from '../router';

interface Props {
  boardId: string;
  role: Role;
  selfUserId: string;
  onClose: () => void;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

export function ShareDialog({ boardId, role, selfUserId, onClose }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<GrantableRole>('editor');
  const isOwner = role === 'owner';

  const load = useCallback(async () => {
    try {
      const r = await api.listMembers(boardId);
      setMembers(r.members);
      setInvites(r.invites ?? []);
      setError('');
    } catch (e) {
      setError(messageOf(e));
    }
  }, [boardId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function invite(ev: React.FormEvent) {
    ev.preventDefault();
    if (!email.trim()) return;
    await run(async () => {
      await api.addMember(boardId, email.trim(), inviteRole);
      setEmail('');
    });
  }

  async function leave() {
    try {
      await api.removeMember(boardId, selfUserId);
      navigate('/');
    } catch (e) {
      setError(messageOf(e));
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a mouse shortcut; keyboard users close with Escape
    <div className="scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share" role="dialog" aria-modal="true" aria-label="Share board">
        <header className="modal-head">
          <h2>Share this board</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        <ul className="members" data-testid="members">
          {members.map((m) => (
            <li key={m.userId} className="member-row" data-testid="member">
              <span className="avatar" style={{ background: m.color }} aria-hidden>
                {m.name[0]}
              </span>
              <span className="member-name">
                {m.name}
                {m.userId === selfUserId && ' (you)'}
                {m.email && <small>{m.email}</small>}
              </span>
              {isOwner && m.role !== 'owner' ? (
                <>
                  <select
                    aria-label={`Role for ${m.name}`}
                    value={m.role}
                    onChange={(e) => void run(() => api.setMemberRole(boardId, m.userId, e.target.value as GrantableRole))}
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button
                    type="button"
                    className="btn ghost"
                    aria-label={`Remove ${m.name}`}
                    onClick={() => void run(() => api.removeMember(boardId, m.userId))}
                  >
                    Remove
                  </button>
                </>
              ) : (
                <span className="role-badge">{m.role}</span>
              )}
            </li>
          ))}
        </ul>

        {isOwner && invites.length > 0 && (
          <>
            <h3>Pending invites</h3>
            <ul className="members" data-testid="invites">
              {invites.map((i) => (
                <li key={i.email} className="member-row">
                  <span className="member-name">{i.email}</span>
                  <span className="role-badge">{i.role}</span>
                  <button
                    type="button"
                    className="btn ghost"
                    aria-label={`Withdraw invite for ${i.email}`}
                    onClick={() => void run(() => api.removeInvite(boardId, i.email))}
                  >
                    Withdraw
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {isOwner ? (
          <form className="row invite-form" onSubmit={invite}>
            <input
              type="email"
              aria-label="Invite by email"
              placeholder="name@example.com"
              value={email}
              maxLength={200}
              onChange={(e) => setEmail(e.target.value)}
            />
            <select aria-label="Invite role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as GrantableRole)}>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button type="submit" className="btn primary">
              Invite
            </button>
          </form>
        ) : (
          <footer className="modal-foot">
            <button type="button" className="btn danger" onClick={() => void leave()}>
              Leave board
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire viewer mode and the Share button**

`BoardView.tsx`: import `ShareDialog`; add `const [sharing, setSharing] = useState(false);` and `const readOnly = vm.role === 'viewer';`. In the header, before `<PresenceBar>`:

```tsx
        {vm.role && (
          <button type="button" className="btn" data-testid="share" onClick={() => setSharing(true)}>
            Share
          </button>
        )}
```

Pass `readOnly={readOnly}` to every `<Column>` and to `<CardModal>`. Wrap the `<div className="lane add-lane">…</div>` in `{!readOnly && (…)}`. Close the dialog on Escape by extending the existing key handler: `if (e.key === 'Escape') { setOpenCardId(null); setSharing(false); }`. Render after the card modal:

```tsx
      {sharing && vm.role && (
        <ShareDialog boardId={state.board.id} role={vm.role} selfUserId={session.user.id} onClose={() => setSharing(false)} />
      )}
```

`Column.tsx`: add `readOnly: boolean` to `Props` and destructuring; rename on click only when not read-only (`onClick={() => { if (readOnly) return; setName(column.name); setRenaming(true); }}`, `title={readOnly ? undefined : 'Click to rename'}`); render the delete-column button only when `!readOnly`; render the `adding ? <form…> : <button …>` block only when `!readOnly`; pass `readOnly={readOnly}` to `<CardTile>`.

`CardTile.tsx`: add `readOnly: boolean` prop; `draggable={!readOnly}`.

`CardModal.tsx`: add `readOnly: boolean` prop. Title and description get `readOnly={readOnly}` and their `onFocus`/`onBlur` handlers become no-ops when read-only (`onFocus={readOnly ? undefined : focus}`, `onBlur={readOnly ? undefined : () => { blur(); save(); }}`). Wrap the comment `<form>` and the "Delete card" button in `{!readOnly && …}`. The footer's last button reads `{readOnly ? 'Close' : 'Done'}` and skips `save()` when read-only.

`BoardPage.tsx`: in `ConnectedBoard`, before the `!vm.state` check add

```tsx
  if (vm.status === 'removed') {
    return (
      <div className="page center">
        <p role="status" data-testid="no-access">
          You no longer have access to this board.
        </p>
        <button type="button" className="btn primary" onClick={() => navigate('/')}>
          Back to boards
        </button>
      </div>
    );
  }
```

`BoardsPage.tsx`: next to the board link add `<span className="role-badge">{b.role}</span>`; change `useState<Board[] | null>` to `useState<BoardWithRole[] | null>` and its import.

`styles.css`: append, using the existing tokens:

```css
/* ---------- sharing ---------- */
.modal.share {
  width: min(520px, 100%);
}
.members {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.member-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.member-name {
  flex: 1;
  display: grid;
  min-width: 0;
}
.member-name small {
  color: var(--ink-soft);
  font-size: 12px;
}
.role-badge {
  font-size: 12px;
  text-transform: capitalize;
  color: var(--ink-soft);
  background: var(--lane);
  border-radius: 999px;
  padding: 2px 10px;
}
.invite-form input {
  flex: 1;
  min-width: 0;
}
```

- [ ] **Step 3: Verify**

Run: `npm run lint && npm run typecheck && npx vitest run --project unit`
Expected: all clean/pass. Open the app (`npm run dev`) as a sanity check only; the e2e tests in Task 8 are the real verification.

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "feat(web): Share dialog, viewer mode, no-access screen and role badges"
```

---

### Task 8: Seed, e2e, docs and full verification

**Files:**
- Modify: `apps/server/src/seed.ts`, `e2e/two-users.spec.ts`, `e2e/helpers.ts`, `README.md`, `TASKS.md`
- Create: `e2e/sharing.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `inviteViaApi(page, origin, boardPath, email, role)` e2e helper.

- [ ] **Step 1: Seed the demo board's members**

In `seed.ts`, after `const snap = await service.createBoard(owner.id, 'Product Launch (demo)');` add:

```ts
for (const person of users.slice(1)) {
  await pool.query("INSERT INTO board_members (board_id, user_id, role) VALUES ($1, $2, 'editor') ON CONFLICT DO NOTHING", [
    snap.board.id,
    person.id,
  ]);
}
```

- [ ] **Step 2: Fix the existing e2e fixture (this fails before the change)**

Run: `npx playwright test e2e/two-users.spec.ts` and confirm it fails (Grace cannot open Ada's new board). Then add to `e2e/helpers.ts`:

```ts
/** Invites someone through the REST API as the signed-in user of `page`. */
export async function inviteViaApi(page: Page, origin: string, boardPath: string, email: string, role: 'editor' | 'viewer') {
  const token = await page.evaluate(() => (JSON.parse(localStorage.getItem('realtime-board.session') ?? 'null') as { token: string } | null)?.token);
  const boardId = boardPath.split('/').at(-1);
  const res = await page.request.post(`${origin}/api/boards/${boardId}/members`, {
    headers: { authorization: `Bearer ${token}` },
    data: { email, role },
  });
  expect(res.ok()).toBe(true);
}
```

and in `openSharedBoard` (two-users.spec.ts) between reading `path` and signing Grace in, call
`await inviteViaApi(ada, E2E.webA, path, 'grace@example.test', 'editor');` (import it from `./helpers`). Re-run: `npx playwright test e2e/two-users.spec.ts` → PASS.

- [ ] **Step 3: Write the sharing e2e spec**

Create `e2e/sharing.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { E2E } from '../playwright.config';
import { signInAs } from './helpers';

test('an owner invites through the Share dialog, a viewer cannot edit, and removal ends access live', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ada = await ctxA.newPage();
  const grace = await ctxB.newPage();

  await signInAs(ada, E2E.webA, 'Ada Lovelace');
  await ada.getByLabel('New board name').fill(`Shared ${Date.now()}`);
  await ada.getByRole('button', { name: 'Create board' }).click();
  await expect(ada.getByTestId('lanes')).toBeVisible();
  const path = new URL(ada.url()).pathname;

  await test.step('a stranger cannot open the board', async () => {
    await signInAs(grace, E2E.webB, 'Grace Hopper');
    await grace.goto(`${E2E.webB}${path}`);
    await expect(grace.getByTestId('no-access')).toBeVisible();
  });

  await test.step('Ada invites Grace as a viewer from the Share dialog', async () => {
    await ada.getByTestId('share').click();
    const dialog = ada.getByRole('dialog', { name: 'Share board' });
    await dialog.getByLabel('Invite by email').fill('grace@example.test');
    await dialog.getByLabel('Invite role').selectOption('viewer');
    await dialog.getByRole('button', { name: 'Invite' }).click();
    await expect(dialog.getByTestId('member')).toHaveCount(2);
    await ada.keyboard.press('Escape');
  });

  await test.step('Grace sees the board read-only', async () => {
    await grace.goto(`${E2E.webB}${path}`);
    await expect(grace.getByTestId('lanes')).toBeVisible();
    await expect(grace.getByRole('button', { name: '+ Add card' })).toHaveCount(0);
    await expect(grace.getByRole('button', { name: '+ Add column' })).toHaveCount(0);
  });

  await test.step('Ada upgrades her to editor and the controls appear without a reload', async () => {
    await ada.getByTestId('share').click();
    await ada.getByRole('dialog', { name: 'Share board' }).getByLabel('Role for Grace Hopper').selectOption('editor');
    await ada.keyboard.press('Escape');
    await expect(grace.getByRole('button', { name: '+ Add card' }).first()).toBeVisible();
  });

  await test.step('Ada removes Grace and she is cut off immediately', async () => {
    await ada.getByTestId('share').click();
    await ada.getByRole('dialog', { name: 'Share board' }).getByRole('button', { name: 'Remove Grace Hopper' }).click();
    await expect(grace.getByTestId('no-access')).toBeVisible();
  });

  await ctxA.close();
  await ctxB.close();
});
```

Run: `npx playwright test e2e/sharing.spec.ts`. Fix selectors against the real DOM if a step fails (for example the `Remove` button's accessible name comes from `aria-label`), then re-run until PASS.

- [ ] **Step 4: Docs**

`README.md`: in "What it does" replace the "Simple auth" bullet's last sentence with a sharing bullet ("**Sharing.** Boards belong to their members. The owner invites people by email as editors or viewers; removing someone, or changing their role, takes effect immediately on every server instance."); in the REST table add the member routes (one row each: `GET/POST /api/boards/:id/members`, `PATCH/DELETE /api/boards/:id/members/:userId`, `DELETE /api/boards/:id/invites/:email`); in the ack error table add `FORBIDDEN` ("A viewer tried to write."); in the client-to-server table note `board:join` returns `role` and that non-members get `NOT_FOUND`; in the server-to-client table add `board:access`; delete "Any signed-in user can open any board (this is a demo, there is no sharing model)." from "Known limits". `TASKS.md`: check off the membership task with a short note on what was verified.

- [ ] **Step 5: Full verification**

Run, and read the output of each:

```bash
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Expected: all pass. Then boot the scale profile (`docker compose --profile scale up -d --build --wait`), confirm both instances are healthy, and stop it again (`docker compose stop nginx server-1 server-2`).

- [ ] **Step 6: Commit**

```bash
git add -A ':!dashboard.html'
git commit -m "feat: seed members, e2e for sharing, docs for board membership"
```
