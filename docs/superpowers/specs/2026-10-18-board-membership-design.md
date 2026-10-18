# Board membership and roles: design

Status: draft for review. Roadmap item: Phase 2, "Board membership and roles" (TASKS.md).

## Problem

Any signed-in user can list, open and edit every board. `boards.owner_id` is stored and never read. The README lists this under "Known limits". Before the app is shared with real people, a board must belong to the people it was shared with.

## Goals

- Only members can see or change a board. Everyone else gets "Board not found".
- Three roles: **owner**, **editor**, **viewer**.
- The owner shares a board by inviting people by email.
- A removed or downgraded user loses access immediately, including live sockets on other server instances.
- Usable end to end: a Share dialog in the board header, and a read-only board for viewers.

## Non-goals

Ownership transfer, deleting boards, share links, organisations or groups, a membership audit log, and invite emails (that arrives with the "Real magic-link email" task; until then an invitee sees the board the next time they sign in).

## Decisions made with the user

| Question | Decision |
| --- | --- |
| How do people get access? | Invite by email. |
| Roles? | Owner / editor / viewer. |
| UI scope? | Backend plus a member panel. |

## Rules

| Action | Owner | Editor | Viewer | Non-member |
| --- | --- | --- | --- | --- |
| See the board in `GET /api/boards`, open it, read snapshot and events, join the socket room | yes | yes | yes | no, `NOT_FOUND` |
| Appear in presence, send cursors, set "editing" | yes | yes | yes | no |
| Create, edit, move or delete columns, cards and comments | yes | yes | no, `FORBIDDEN` | no, `NOT_FOUND` |
| List members (names, colours, roles) | yes | yes | yes | no |
| See member emails and pending invites | yes | no | no | no |
| Invite, change a role, remove someone else | yes | no, `FORBIDDEN` | no, `FORBIDDEN` | no, `NOT_FOUND` |
| Leave the board | no (owner cannot leave) | yes | yes | n/a |

- The owner row can never be removed or demoted.
- Inviting an email that already belongs to a member is a no-op that returns the existing member.
- Roles an owner can grant: `editor` or `viewer`. There is exactly one owner per board, set at creation.
- A non-member always sees the same response as for a board that does not exist, so board ids do not leak.

## Data model (migration 2)

```sql
CREATE TABLE board_members (
  board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX board_members_user_idx ON board_members (user_id);
CREATE UNIQUE INDEX board_members_one_owner ON board_members (board_id) WHERE role = 'owner';

CREATE TABLE board_invites (
  board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  email      text NOT NULL,            -- stored lower-cased
  role       text NOT NULL CHECK (role IN ('editor','viewer')),
  invited_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, email)
);

-- Existing boards keep working: their owner becomes the owner member.
INSERT INTO board_members (board_id, user_id, role)
SELECT id, owner_id, 'owner' FROM boards WHERE owner_id IS NOT NULL;
```

A board whose `owner_id` is NULL (only possible if its owner's user row was deleted, and no code deletes users) gets no members and becomes unreachable. `boards.owner_id` stays as the creation record but is no longer used for access.

## Server design

### BoardService

- `role(boardId, userId): Role | null`, a single indexed lookup.
- `listBoards(userId)`: boards joined through `board_members`, each with `role`.
- `createBoard`: inserts the owner `board_members` row in the same transaction as the board and its default columns.
- `commit()` (the board-locked transaction every command already uses) takes the actor's id, reads the role inside the transaction and throws `NOT_FOUND` for a non-member or `FORBIDDEN` for a viewer before running the command. Reading it inside the lock means a revocation committed just before is always seen. All commands need `editor` or above.
- Member management: `listMembers`, `addMember(boardId, actorId, email, role)`, `setRole`, `removeMember`, `removeInvite`. Each checks that the actor is the owner (or, for `removeMember`, is removing themselves) and rejects changes to the owner row.
- `addMember` on an email with an account inserts the member row directly. On an unknown email it inserts a `board_invites` row.

### Invites are claimed at sign-in

`upsertUser` is the single place every sign-in path goes through (dev login, magic link verify, seed, tests). After the upsert it runs one statement that moves matching `board_invites` rows into `board_members` (skipping boards the user is already in) and deletes them. Dev login does not verify the email, so it can claim anyone's invites; it is disabled in production, and the magic-link path proves the address.

### REST (all under the existing auth middleware)

| Route | Who | Result |
| --- | --- | --- |
| `GET /api/boards` | any user | only the user's boards, each with `role` |
| `POST /api/boards` | any user | creates a board, caller is owner |
| `GET /api/boards/:id`, `GET /api/boards/:id/events` | members | as today; non-member gets 404 |
| `GET /api/boards/:id/members` | members | `{ members: [{ userId, name, color, role, email? }], invites?: [{ email, role }] }`; `email` and `invites` only for the owner |
| `POST /api/boards/:id/members` | owner | body `{ email, role }`, returns the member or invite |
| `PATCH /api/boards/:id/members/:userId` | owner | body `{ role }` |
| `DELETE /api/boards/:id/members/:userId` | owner, or the member themselves | removes the member |
| `DELETE /api/boards/:id/invites/:email` | owner | removes a pending invite |

Status mapping: not a member is 404, a member without permission is 403, validation errors are 400 as today. Request bodies are validated with zod schemas in `packages/shared` so the client and server share them.

### Sockets

- `FORBIDDEN` is added to `ERROR_CODES`. A viewer's command is acknowledged with `{ ok: false, code: 'FORBIDDEN' }`.
- `board:join` for a non-member returns `NOT_FOUND`. A successful join ack includes `role`.
- Each socket also joins a `user:{id}` room on connect.
- **Access changes reach live sockets.** When a role changes or a member is removed, the instance handling the REST call (a) applies the change locally and (b) calls `io.serverSideEmit('access:changed', { boardId, userId, role })`, which the Redis adapter delivers to the other instances. Each instance runs the same handler on its local sockets for that user: on removal it calls the existing `leave(boardId)` (leaves the room, removes presence, rebroadcasts the roster); in both cases it emits `board:access { boardId, role | null }` to the user's sockets. The writes are already blocked by the in-transaction check, so this handler only has to stop the reads and update the UI.
- The REST layer reaches the gateway through a callback (`onAccessChanged`) passed into `createApp` and wired in `server.ts`, because the Socket.IO server is created after the app.

## Web design

- `BoardClient` stores `role` from the join ack and updates it on `board:access`. On `role = null` it sets status `removed`.
- `BoardPage` shows a "You no longer have access to this board" message with a link back to the boards list when status is `removed`.
- **Share dialog** (new `ShareDialog.tsx`, opened from a Share button in the board header, visible to every member):
  - member list (avatar, name, role). The owner gets a role select and a Remove button per row. Everyone else gets a read-only list, plus a Leave button for non-owners.
  - owner only: an invite form (email + role) and a list of pending invites with Remove.
  - API calls go through `api.ts`; the dialog reloads the list after each change.
- **Viewer mode:** when `role === 'viewer'` the add-card and add-column buttons are hidden, cards are not draggable, the column rename and delete controls are hidden, and the card modal fields are `readOnly` with comment, delete and save controls hidden. Server enforcement is the real guard; this is so the UI does not offer actions that will fail.
- `BoardsPage` shows a role badge on each board.

## Seed and fixtures

- `seed.ts` adds Grace and Linus as editors of the demo board.
- The e2e helper invites the second persona through the REST API before she opens the board (the two-user specs depend on both users seeing one board).

## Testing

Written first, in this order, each watched failing before the code:

1. **Service integration:** membership backfill, `role()`, `listBoards` filtering, owner row protections, `addMember` for a known and an unknown email, invite claim on `upsertUser`, removing a member.
2. **Socket integration (two instances):** non-member join gets `NOT_FOUND`; viewer command gets `FORBIDDEN` and writes nothing; an editor downgraded to viewer is refused on their next command; a removed member on the other instance stops receiving `board:event`s and gets `board:access` with `null`; roster no longer lists them.
3. **REST integration:** the permission matrix above (404 / 403 / 200), email visibility for non-owners, invite lifecycle.
4. **Web unit tests:** `BoardClient` handles `role` in the join ack, `board:access` downgrade and removal.
5. **E2E:** owner invites a second user in the Share dialog and she sees the board; a viewer cannot add a card; removal sends the removed user back to the boards list.

## Risks and open points

- Every command gains one indexed query inside the already-serialised transaction. Writers on a board are serial anyway, so this adds a small constant to each command, not contention.
- An owner whose account is removed leaves a board nobody can open. No code deletes users today; revisit if account deletion is added.
- Invites sent to a mistyped address stay pending forever. The owner can remove them from the dialog; no expiry for now.
