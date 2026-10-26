# Realtime Board

[![CI](https://github.com/kevinmakwana/realtime-board/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinmakwana/realtime-board/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A collaborative kanban board where several people edit the same board at once and everyone sees cards move, comments land, cursors drift and "Ada is editing" badges appear as it happens. It is built to stay correct when it runs on **more than one server**: events cross instances through Redis, conflicting edits are rejected by version, and a client that drops offline catches up on exactly what it missed.

**Stack:** Node 22 · Express 5 · Socket.IO 4 + Redis adapter · Postgres · React 19 + Vite · zod · Vitest · Playwright · TypeScript (strict)

![Two browser windows, connected to server-1 and server-2, syncing the same board](docs/demo.gif)

*Left window: connected to `server-1`. Right window: connected to `server-2`. Same board, synced through Redis.*

## What it does

- **Boards, columns, cards, comments** with drag and drop. Order uses fractional indexing, so a move rewrites one row, never its neighbours.
- **Moving without a mouse.** On a focused card, `Alt`+arrow keys move it (up/down within the column, left/right to the next column) and a screen-reader announcement says where it went. Column headers have move-left/right buttons, the column name is a button (Enter renames), and the card dialog has Column and Position selects, which is also how to reorder on a touch screen (browsers do not fire HTML5 drag events for touch). Dialogs move focus in, keep Tab inside, and return focus when closed.
- **Optimistic updates.** Your change shows instantly. If the server rejects it, it is rolled back and you are told why.
- **Conflict handling.** Every card has a version. An edit or move based on a stale version is rejected, and the client resyncs.
- **Presence.** Who is on the board, throttled live cursors, and "X is editing" on the card. Presence lives in Redis with a TTL, so a crashed browser or server disappears on its own.
- **Offline changes.** Edits made while the connection is down show at once and wait in the tab (up to 100); the header says how many. When the connection is back they are sent one at a time in the order they were made, each against the card version it was made on, so an edit to a card someone else changed meanwhile is refused and reported instead of overwriting theirs. The queue is kept in memory only: closing the tab with changes waiting asks the browser to confirm, and a reload loses them.
- **Reconnect catch-up.** Each board has a gapless event sequence. A client rejoins with its last seen `seq` and gets the missed events replayed from Postgres (or a fresh snapshot if it is too far behind).
- **Horizontal scale.** `@socket.io/redis-adapter`, per-socket rate limiting, and a docker compose profile that runs two instances behind nginx with sticky sessions.
- **Sharing and roles.** A board belongs to its members. The owner invites people by email as **editors** (can change the board) or **viewers** (read-only), from the Share dialog. Changing someone's role or removing them takes effect immediately, on every server instance, even for a tab that is already open. Invites for people without an account wait until they first sign in with that email.
- **Simple auth.** One-click fictional demo logins, or an email magic link. Without an SMTP server the email is printed to the server console, so nothing paid is needed to run it.

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    A["Browser A"]
    B["Browser B"]
    C["Browser C"]
  end
  LB["nginx<br/>load balancer<br/>(sticky per tab)"]
  subgraph Instances["Server instances (Node + Socket.IO)"]
    S1["server-1"]
    S2["server-2"]
    SN["server-N"]
  end
  R[("Redis<br/>pub/sub adapter<br/>presence + TTL")]
  P[("Postgres<br/>boards, cards,<br/>board_events log")]

  A & B & C -->|"HTTP + WebSocket"| LB
  LB --> S1 & S2 & SN
  S1 & S2 & SN <-->|"adapter fan-out<br/>presence"| R
  S1 & S2 & SN -->|"commit change + event<br/>in one transaction"| P
```

How one edit travels:

1. The client applies the change locally (optimistic) and sends a command with the card's `baseVersion`.
2. The server validates it with the shared zod schema, then in **one Postgres transaction** locks the board row, checks the version, applies the change, bumps `boards.last_seq` and appends the event to `board_events`.
3. After commit, the server emits `board:event` to the board's room. The Redis adapter delivers it to sockets on every other instance.
4. Every client feeds events through a reorder buffer and applies them strictly in `seq` order. The sender's optimistic layer is dropped once the log has caught up with its ack.

Shared types and schemas live in [`packages/shared`](packages/shared), so the client and the server cannot drift apart. The board reducer, the optimistic overlay and the reorder buffer are pure functions there, and both the browser and the tests use them.

## Quick start

Requires Node 22+ and Docker.

```bash
npm install
cp .env.example .env        # optional: change host ports here
npm run infra:up            # Postgres + Redis (host ports 5434 / 6381 by default)
npm run dev                 # API on :3001, web on http://localhost:5180
npm run seed                # optional: a demo board with fictional people and cards
```

Open <http://localhost:5180> and sign in as a demo person. Open a second window in a private tab and sign in as someone else to see the sync.

**Magic link instead:** enter any email on the sign-in page. With no `SMTP_URL` set, the email is printed in the terminal running the server; open the link in the browser to finish signing in. To see real emails locally, run a catcher such as `docker run -p 1025:1025 -p 8025:8025 axllent/mailpit` and set `SMTP_URL=smtp://localhost:1025`; they appear at <http://localhost:8025>. Links are single use and expire after 15 minutes.

### Run two instances behind nginx

```bash
docker compose --profile scale up --build
```

Open two windows:

- <http://localhost:8088/?node=1> (pinned to `server-1`)
- <http://localhost:8088/?node=2> (pinned to `server-2`)

The badge in the header shows which instance each window is on. Without `?node=`, nginx spreads tabs across instances by a per-tab id (see [Scaling notes](#scaling-notes)).

To run published images instead of building them, see the [deploy guide](docs/deploy.md). Host ports are configurable: `POSTGRES_PORT`, `REDIS_PORT`, `NGINX_PORT` (see [`.env.example`](.env.example)).

### Tests

```bash
npm run lint                 # Biome: lint + format check (npm run lint:fix to fix, npm run format to format)
npm run typecheck
npm run test:unit            # schemas, ordering, reducer, sequence buffer, client engine, rate limiter, and the React components (jsdom + Testing Library)
npm run test:integration     # needs `npm run infra:up`; starts TWO server instances on one Redis; includes a route-by-route REST suite
npx playwright install chromium
npm run test:e2e             # two browser contexts on two instances edit the same board
npm run demo:gif             # re-record docs/demo.gif against the scale profile
npm run loadtest             # k6 against the scale profile; see docs/load-testing.md
```

| Layer | What it proves |
| --- | --- |
| Unit | event schema validation, fractional ordering and collision handling, reducer idempotency, sequence reordering, optimistic apply and rollback, cursor throttling, token bucket |
| Integration | an event committed on instance A reaches a client on instance B; stale versions are rejected; gapless `seq` under 24 concurrent writers on two instances; replay and snapshot fallback on reconnect; presence expiry |
| End to end | two Chromium contexts on two instances: live sync, drag and drop ordering, "is editing", comments, cursors, and recovery after the transport is cut |

## Event protocol

All client commands are Socket.IO events with an acknowledgement callback. Payloads are validated with the zod schemas in [`packages/shared/src/events.ts`](packages/shared/src/events.ts) before they reach the database.

### Client to server

| Event | Payload | Ack | Notes |
| --- | --- | --- | --- |
| `board:join` | `{ boardId, lastSeq? }` | `{ mode: 'snapshot', snapshot }` or `{ mode: 'replay', events, seq }`, plus `instance`, `presence`, `role` | Joins the room first, then reads state. Replays only if the log is contiguous and within `REPLAY_MAX_EVENTS`. Non-members get `NOT_FOUND`. |
| `board:leave` | `{ boardId }` | `{}` | |
| `board:rename` | `{ boardId, name }` | `{ seq }` | Owner only (`FORBIDDEN` otherwise). Renaming to the current name writes nothing. |
| `column:create` | `{ id, boardId, name, position }` | `{ seq }` | Client-generated ids make retries idempotent. |
| `column:rename` | `{ id, boardId, name }` | `{ seq }` | |
| `column:move` | `{ id, boardId, position }` | `{ seq }` | Reorder. Answered with a `column.updated` event. A position someone else just took is nudged to a free key next to it. |
| `column:delete` | `{ id, boardId }` | `{ seq }` | Cascades to its cards. |
| `card:create` | `{ id, boardId, columnId, title, position }` | `{ seq, version }` | |
| `card:update` | `{ id, boardId, baseVersion, title?, description?, dueDate?, assigneeIds?, labels? }` | `{ seq, version }` | `VERSION_CONFLICT` if `baseVersion` is stale. `dueDate` is `YYYY-MM-DD` or `null` to clear; `assigneeIds` (max 10) must all be board members; `labels` (max 5, 24 chars) are de-duplicated ignoring case. Omitted fields are left alone. |
| `card:move` | `{ id, boardId, baseVersion, columnId, position }` | `{ seq, version }` | Same version check. `position` is a fractional key. |
| `card:delete` | `{ id, boardId, baseVersion }` | `{ seq }` | Same version check. |
| `comment:add` | `{ id, boardId, cardId, body }` | `{ seq }` | |
| `comment:edit` | `{ id, boardId, body }` | `{ seq }` | Author only (`FORBIDDEN` otherwise, even for the board owner). Saving the same text writes nothing. |
| `comment:delete` | `{ id, boardId }` | `{ seq }` | The author, or the board owner moderating. |
| `presence:editing` | `{ boardId, cardId \| null }` | `{}` | Stored in Redis with the member record. |
| `presence:cursor` | `{ boardId, x, y }` (0 to 1) | none | Fire and forget, volatile, rate limited separately. |

### Server to client

| Event | Payload | Notes |
| --- | --- | --- |
| `board:event` | `{ seq, type, boardId, actorId, ts, ... }` | One per committed change, sent to every socket in the board room on every instance. |
| `presence:update` | `{ boardId, members[] }` | Full roster: socket, user, instance, `editingCardId`. |
| `presence:cursor` | `{ socketId, userId, boardId, x, y }` | Not sent back to the sender. |
| `board:access` | `{ boardId, role }` | Your role changed; `role` is `null` when you were removed from the board (the server also takes you out of its room). |

`board:event` types: `board.renamed`, `column.created`, `column.updated`, `column.deleted`, `card.created`, `card.updated`, `card.moved`, `card.deleted`, `comment.added`, `comment.updated`, `comment.deleted`. Card events carry the full card, so applying them is idempotent.

### Acks and errors

Success is `{ ok: true, seq, version? }`. Failure is `{ ok: false, code, message }`.

| Code | Meaning |
| --- | --- |
| `VALIDATION` | Payload failed the zod schema (the message lists the fields). |
| `VERSION_CONFLICT` | Someone changed the card first. The ack includes `current` so the client can resync. |
| `NOT_FOUND` | Board, column or card does not exist (or was just deleted), or you are not a member of the board. |
| `FORBIDDEN` | You are a viewer and tried to write. |
| `NOT_JOINED` | The socket has not joined that board. |
| `RATE_LIMITED` | The socket's token bucket is empty. |
| `UNAUTHORIZED` | Handshake rejected (bad or missing JWT). |
| `INTERNAL` | Unexpected server error (logged, not leaked). |

### REST

| Route | Purpose |
| --- | --- |
| `POST /api/auth/dev-login` | `{ email, name? }` returns a JWT. Disabled when `NODE_ENV=production` unless `AUTH_DEV_LOGIN=true`. All `/api/auth/*` routes answer `429` with `Retry-After` when rate limited. |
| `POST /api/auth/magic-link` | `{ email }` emails a single-use sign-in link (printed to the server console when no SMTP server is configured). Always answers `{ ok: true }`, whether or not the email could be delivered. |
| `POST /api/auth/verify` | `{ token }` exchanges a magic-link token for a JWT. |
| `GET /api/boards?limit=50&before=<cursor>`, `POST /api/boards` | One page of your boards, newest first, each with your `role`: `{ boards, nextCursor }` (`limit` 1 to 100; pass `nextCursor` as `before` for the next page, `null` on the last). Or create one (new boards get To do, In progress, Done; the creator is the owner). |
| `GET /api/boards/:id` | Snapshot with its `seq`. Members only; anyone else gets `404`. |
| `GET /api/boards/:id/events?after=N` | Event log slice. Members only. `410` when the log before `N` has been pruned (see retention below): load a snapshot instead. |
| `GET /api/boards/:id/cards/:cardId/comments?before=<cursor>&limit=50` | A page of older comments, oldest first: `{ comments, nextCursor }`. Members only, viewers included. The snapshot carries only the newest 50 comments of each card plus, in `olderComments`, how many are missing and the first cursor. |
| `GET /api/boards/:id/activity?limit=50` | The latest changes as readable lines (`{ entries: [{ seq, ts, actorName, text }] }`), newest first. Members only, viewers included. `limit` is clamped to 200. Built from the event log by `describeActivity` in `packages/shared`. |
| `GET /api/boards/:id/members` | Members with names, colours and roles. The owner also gets emails and pending invites. |
| `POST /api/boards/:id/members` | Owner only. `{ email, role: 'editor' \| 'viewer' }`. An existing user is added at once, anyone else gets a pending invite. |
| `PATCH /api/boards/:id/members/:userId` | Owner only. `{ role }`. The owner's own role cannot change. |
| `DELETE /api/boards/:id` | Owner only. Deletes the board with its columns, cards, comments, event log, members and invites (waiting for any command already running), and cuts every member's open tabs off. |
| `DELETE /api/boards/:id/members/:userId` | The owner removes anyone but themselves; any other member can remove themselves (leave). |
| `DELETE /api/boards/:id/invites/:email` | Owner only. Withdraw a pending invite. |
| `GET /health` | Liveness: `{ ok, instance }`. Touches no dependency. |
| `GET /ready` | Readiness: pings Postgres and Redis (2 s deadline each). `200` with `{ ok: true, checks }`, or `503` naming the dependency that failed. The compose healthchecks use it. |
| `GET /metrics` | Prometheus text: process metrics, `http_requests_total`, `http_request_duration_seconds`, `ws_connections`, `board_commands_total{command,result}` and `board_command_duration_seconds`, all labelled with the instance. nginx does not proxy it, so scrape each instance directly. |

## Scaling notes

- **Retention.** The board is the `columns`, `cards` and `comments` tables, which are always current, so they already act as the snapshot; the event log only serves reconnect catch-up and the activity feed. Each instance periodically (`RETENTION_INTERVAL_MINUTES`) tries to delete events older than `EVENT_RETENTION_DAYS` while always keeping a board's newest `EVENT_RETENTION_MIN_EVENTS`; a Postgres advisory lock lets one instance at a time do it, in batches, and `board_events_pruned_total` counts the rows. `boards.last_seq` is never touched, so numbering stays gapless. A client whose position was pruned gets a snapshot when it rejoins, because the gateway replays only a contiguous log.
- **Presence broadcasts.** "Is editing" changes re-send the roster to the board; per board that is at most one every `PRESENCE_BROADCAST_MIN_MS`, the first immediately and the last state always. `Presence.setEditing` is one atomic Redis script, so it cannot resurrect a member who left meanwhile.

- **Fan-out.** Every instance publishes to and subscribes from Redis through `@socket.io/redis-adapter`, so `io.to(room).emit` reaches sockets on any instance. Postgres is the only writer of truth, and Redis is never required to be durable.
- **Ordering.** Writers on the same board are serialised by a row lock (`SELECT ... FOR UPDATE`), so `last_seq + 1` is gapless and commit order is `seq` order. Two instances can still *publish* seq 5 and 6 in the opposite order. Clients hold back anything past `lastSeq + 1` and, if the hole does not fill within 400 ms, rejoin with their `lastSeq` to fetch it.
- **Why a log and not just pub/sub.** Redis pub/sub is at-most-once. A client that is offline, or just briefly disconnected, would silently miss events. The Postgres event log is what makes catch-up exact. Past `REPLAY_MAX_EVENTS` (500) a snapshot is cheaper than a replay, so the server sends that instead.
- **Offline queue details.** Only card changes are version-checked. Renames, column moves and comment edits carry no version, so a replay applies them as written (the last writer wins), and deleting a column is refused while offline because it would also delete cards others added meanwhile. A change the replay had sent when the connection dropped again goes back in the queue and is sent again on the next join (creates are safe to repeat; a card change that had in fact landed is refused as a conflict and the board resyncs to show it). Changes that were in flight when the first drop happened have an unknown outcome and are dropped from the view; catch-up shows what really happened.
- **Conflicts.** Version checks are optimistic concurrency, not merging. The second of two concurrent edits to one card is rejected with the current card and the client resyncs. Concurrent drops into the same gap are resolved server-side: the later key is moved to sit directly after the colliding one.
- **Sticky sessions.** Socket.IO's long-polling handshake needs every request of a session on one instance, even with the Redis adapter. The web app adds a random per-tab `cid` to every Socket.IO request and nginx does `hash $arg_cid consistent`. Hashing on `$remote_addr` would pin every local tab to one instance. `?node=1|2` overrides this for demos. `proxy_read_timeout` is 120 s, above Socket.IO's 25 s ping interval plus 20 s ping timeout.
- **Presence.** Each socket has a Redis key with a TTL (default 30 s) and an entry in a per-board sorted set. Instances refresh the keys of their own sockets every TTL/3. If a client or a whole instance dies, its keys expire, `list()` prunes the dangling index entries, and surviving instances notice the roster changed on their next heartbeat and rebroadcast it.
- **Rate limiting.** One token bucket per socket for commands (default 20/s sustained, burst 40) and a separate one for cursors (30/s). A noisy socket gets `RATE_LIMITED` acks and does not affect others. The limits are per instance process, which is per socket, so they do not need Redis.
- **Operations.** Logs are one JSON object per line in production (`LOG_FORMAT=json`, with `time`, `level`, `instance`, `msg` and fields) and readable text otherwise. Every HTTP request is logged by method, path and status (never the query string); probes and scrapes are not. Socket commands are counted by outcome, so a rise in `FORBIDDEN`, `VERSION_CONFLICT` or `INTERNAL` shows up without reading logs.
- **HTTP hardening.** `/api/auth/*` is rate limited per client IP, and magic links are also limited per email address. Both limiters count in Redis, so the budget is shared by every instance, and they fail open if Redis is unreachable. Helmet sets the standard security headers. Set `TRUST_PROXY` to the number of proxies in front of the server (the compose profile uses 1); leaving it at 0 means a spoofed `X-Forwarded-For` cannot dodge a limit.
- **Throttling on the client.** Cursor packets go out at most every 50 ms and always end on the latest position.
- **Access control.** Every command re-reads the actor's role inside the same board-locked transaction that writes the event, so a removal or downgrade that has committed is always seen by the next write. Live sockets learn about the change through `io.serverSideEmit` (delivered by the Redis adapter), and a removed socket leaves the board room and the presence roster. Non-members get the same answer as for a board that does not exist, so ids do not leak.
- **Capacity.** In our [load test](docs/load-testing.md) (100 users, 10 boards, about 200 commands/s, both instances, on one laptop) p95 acknowledgement was 21 to 72 ms and fan-out to a socket on the other instance p95 24 to 75 ms, with no lost, duplicated or refused events. See that page for what it does and does not show.
- **Known limits.** `count` of unloaded comments is a hint, and a full re-snapshot forgets older comment pages loaded before it.

## Project layout

```
apps/server     Express 5 + Socket.IO gateway, board service, presence, migrations
apps/web        React + Vite client, BoardClient sync engine
packages/shared zod schemas, event types, ordering, reducer, sequence buffer
e2e/            Playwright specs (two contexts, two instances)
docker/         nginx config for the scale profile
```

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3001` | HTTP + Socket.IO port |
| `INSTANCE_ID` | `server-1` | Shown in the UI and `/health` |
| `DATABASE_URL` | `postgres://board:board@localhost:5434/board` | |
| `REDIS_URL` | `redis://localhost:6381` | |
| `PG_POOL_MAX` | `10` | Postgres connections per instance; every write holds one for its transaction. Keep instances × this below Postgres' `max_connections` |
| `JWT_SECRET` | `dev-only-change-me` | The server refuses to start with this value when `NODE_ENV=production` |
| `COMPOSE_JWT_SECRET` | demo value | Compose only: the secret used by the `scale` profile (it runs with `NODE_ENV=production`) |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front of the server (nginx = 1). Needed for per-client rate limits to see real IPs |
| `AUTH_RATE_LIMIT_PER_MIN` | `20` | Requests per client IP per minute across `/api/auth/*` |
| `MAGIC_LINK_PER_EMAIL_PER_HOUR` | `5` | Magic links one address can be sent per hour |
| `LOG_FORMAT` | `json` in production, `text` otherwise | Log line format |
| `SMTP_URL` | unset | For example `smtp://user:pass@smtp.example.com:587` (`smtps://` for TLS). Unset: emails are printed to the log. The server warns at start-up if this is unset in production |
| `MAIL_FROM` | `Realtime Board <no-reply@localhost>` | The From address of sign-in and invitation emails |
| `PRESENCE_TTL_SECONDS` | `30` | |
| `PRESENCE_BROADCAST_MIN_MS` | `150` | Minimum gap between roster broadcasts caused by "is editing" changes, per board (0 sends every one) |
| `EVENT_RETENTION_DAYS` | `90` | Board events older than this may be pruned. `0` keeps everything |
| `EVENT_RETENTION_MIN_EVENTS` | `1000` | Each board always keeps at least this many of its newest events (minimum 500) |
| `RETENTION_INTERVAL_MINUTES` | `60` | How often each instance tries to prune; `0` never |
| `RATE_LIMIT_PER_SEC` / `RATE_LIMIT_BURST` | `20` / `40` | Commands per socket |
| `CURSOR_RATE_PER_SEC` | `30` | |
| `REPLAY_MAX_EVENTS` | `500` | Replay window before falling back to a snapshot |

All people, emails and cards in the demo data are fictional (`@example.test`).

## License

[MIT](LICENSE) © Kevin Makwana
