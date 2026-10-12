# Realtime Board

[![CI](https://github.com/kevinmakwana/realtime-board/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinmakwana/realtime-board/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A collaborative kanban board where several people edit the same board at once and everyone sees cards move, comments land, cursors drift and "Ada is editing" badges appear as it happens. It is built to stay correct when it runs on **more than one server**: events cross instances through Redis, conflicting edits are rejected by version, and a client that drops offline catches up on exactly what it missed.

**Stack:** Node 22 · Express 5 · Socket.IO 4 + Redis adapter · Postgres · React 19 + Vite · zod · Vitest · Playwright · TypeScript (strict)

![Two browser windows, connected to server-1 and server-2, syncing the same board](docs/demo.gif)

*Left window: connected to `server-1`. Right window: connected to `server-2`. Same board, synced through Redis.*

## What it does

- **Boards, columns, cards, comments** with drag and drop. Order uses fractional indexing, so a move rewrites one row, never its neighbours.
- **Optimistic updates.** Your change shows instantly. If the server rejects it, it is rolled back and you are told why.
- **Conflict handling.** Every card has a version. An edit or move based on a stale version is rejected, and the client resyncs.
- **Presence.** Who is on the board, throttled live cursors, and "X is editing" on the card. Presence lives in Redis with a TTL, so a crashed browser or server disappears on its own.
- **Reconnect catch-up.** Each board has a gapless event sequence. A client rejoins with its last seen `seq` and gets the missed events replayed from Postgres (or a fresh snapshot if it is too far behind).
- **Horizontal scale.** `@socket.io/redis-adapter`, per-socket rate limiting, and a docker compose profile that runs two instances behind nginx with sticky sessions.
- **Simple auth.** One-click fictional demo logins, or an email magic link that is printed to the server console. No paid services anywhere.

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

**Magic link instead:** enter any email on the sign-in page. The link is printed in the terminal running the server; open it in the browser to finish signing in. Links are single use and expire after 15 minutes.

### Run two instances behind nginx

```bash
docker compose --profile scale up --build
```

Open two windows:

- <http://localhost:8088/?node=1> (pinned to `server-1`)
- <http://localhost:8088/?node=2> (pinned to `server-2`)

The badge in the header shows which instance each window is on. Without `?node=`, nginx spreads tabs across instances by a per-tab id (see [Scaling notes](#scaling-notes)).

Host ports are configurable: `POSTGRES_PORT`, `REDIS_PORT`, `NGINX_PORT` (see [`.env.example`](.env.example)).

### Tests

```bash
npm run typecheck
npm run test:unit            # schemas, ordering, reducer, sequence buffer, client engine, rate limiter
npm run test:integration     # needs `npm run infra:up`; starts TWO server instances on one Redis
npx playwright install chromium
npm run test:e2e             # two browser contexts on two instances edit the same board
npm run demo:gif             # re-record docs/demo.gif against the scale profile
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
| `board:join` | `{ boardId, lastSeq? }` | `{ mode: 'snapshot', snapshot }` or `{ mode: 'replay', events, seq }`, plus `instance`, `presence` | Joins the room first, then reads state. Replays only if the log is contiguous and within `REPLAY_MAX_EVENTS`. |
| `board:leave` | `{ boardId }` | `{}` | |
| `column:create` | `{ id, boardId, name, position }` | `{ seq }` | Client-generated ids make retries idempotent. |
| `column:rename` | `{ id, boardId, name }` | `{ seq }` | |
| `column:delete` | `{ id, boardId }` | `{ seq }` | Cascades to its cards. |
| `card:create` | `{ id, boardId, columnId, title, position }` | `{ seq, version }` | |
| `card:update` | `{ id, boardId, baseVersion, title?, description? }` | `{ seq, version }` | `VERSION_CONFLICT` if `baseVersion` is stale. |
| `card:move` | `{ id, boardId, baseVersion, columnId, position }` | `{ seq, version }` | Same version check. `position` is a fractional key. |
| `card:delete` | `{ id, boardId, baseVersion }` | `{ seq }` | Same version check. |
| `comment:add` | `{ id, boardId, cardId, body }` | `{ seq }` | |
| `presence:editing` | `{ boardId, cardId \| null }` | `{}` | Stored in Redis with the member record. |
| `presence:cursor` | `{ boardId, x, y }` (0 to 1) | none | Fire and forget, volatile, rate limited separately. |

### Server to client

| Event | Payload | Notes |
| --- | --- | --- |
| `board:event` | `{ seq, type, boardId, actorId, ts, ... }` | One per committed change, sent to every socket in the board room on every instance. |
| `presence:update` | `{ boardId, members[] }` | Full roster: socket, user, instance, `editingCardId`. |
| `presence:cursor` | `{ socketId, userId, boardId, x, y }` | Not sent back to the sender. |

`board:event` types: `column.created`, `column.updated`, `column.deleted`, `card.created`, `card.updated`, `card.moved`, `card.deleted`, `comment.added`. Card events carry the full card, so applying them is idempotent.

### Acks and errors

Success is `{ ok: true, seq, version? }`. Failure is `{ ok: false, code, message }`.

| Code | Meaning |
| --- | --- |
| `VALIDATION` | Payload failed the zod schema (the message lists the fields). |
| `VERSION_CONFLICT` | Someone changed the card first. The ack includes `current` so the client can resync. |
| `NOT_FOUND` | Board, column or card does not exist (or was just deleted). |
| `NOT_JOINED` | The socket has not joined that board. |
| `RATE_LIMITED` | The socket's token bucket is empty. |
| `UNAUTHORIZED` | Handshake rejected (bad or missing JWT). |
| `INTERNAL` | Unexpected server error (logged, not leaked). |

### REST

| Route | Purpose |
| --- | --- |
| `POST /api/auth/dev-login` | `{ email, name? }` returns a JWT. Disabled when `NODE_ENV=production` unless `AUTH_DEV_LOGIN=true`. |
| `POST /api/auth/magic-link` | `{ email }` prints a single-use link to the server console. |
| `POST /api/auth/verify` | `{ token }` exchanges a magic-link token for a JWT. |
| `GET /api/boards`, `POST /api/boards` | List or create boards (new boards get To do, In progress, Done). |
| `GET /api/boards/:id` | Snapshot with its `seq`. |
| `GET /api/boards/:id/events?after=N` | Event log slice. |
| `GET /health` | `{ ok, instance }`. |

## Scaling notes

- **Fan-out.** Every instance publishes to and subscribes from Redis through `@socket.io/redis-adapter`, so `io.to(room).emit` reaches sockets on any instance. Postgres is the only writer of truth, and Redis is never required to be durable.
- **Ordering.** Writers on the same board are serialised by a row lock (`SELECT ... FOR UPDATE`), so `last_seq + 1` is gapless and commit order is `seq` order. Two instances can still *publish* seq 5 and 6 in the opposite order. Clients hold back anything past `lastSeq + 1` and, if the hole does not fill within 400 ms, rejoin with their `lastSeq` to fetch it.
- **Why a log and not just pub/sub.** Redis pub/sub is at-most-once. A client that is offline, or just briefly disconnected, would silently miss events. The Postgres event log is what makes catch-up exact. Past `REPLAY_MAX_EVENTS` (500) a snapshot is cheaper than a replay, so the server sends that instead.
- **Conflicts.** Version checks are optimistic concurrency, not merging. The second of two concurrent edits to one card is rejected with the current card and the client resyncs. Concurrent drops into the same gap are resolved server-side: the later key is moved to sit directly after the colliding one.
- **Sticky sessions.** Socket.IO's long-polling handshake needs every request of a session on one instance, even with the Redis adapter. The web app adds a random per-tab `cid` to every Socket.IO request and nginx does `hash $arg_cid consistent`. Hashing on `$remote_addr` would pin every local tab to one instance. `?node=1|2` overrides this for demos. `proxy_read_timeout` is 120 s, above Socket.IO's 25 s ping interval plus 20 s ping timeout.
- **Presence.** Each socket has a Redis key with a TTL (default 30 s) and an entry in a per-board sorted set. Instances refresh the keys of their own sockets every TTL/3. If a client or a whole instance dies, its keys expire, `list()` prunes the dangling index entries, and surviving instances notice the roster changed on their next heartbeat and rebroadcast it.
- **Rate limiting.** One token bucket per socket for commands (default 20/s sustained, burst 40) and a separate one for cursors (30/s). A noisy socket gets `RATE_LIMITED` acks and does not affect others. The limits are per instance process, which is per socket, so they do not need Redis.
- **Throttling on the client.** Cursor packets go out at most every 50 ms and always end on the latest position.
- **Known limits.** Any signed-in user can open any board (this is a demo, there is no sharing model). The event log is never compacted. Comments are loaded with the snapshot, which is fine for small boards but would need paging for large ones.

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
| `JWT_SECRET` | `dev-only-change-me` | Change it for anything beyond local use |
| `PRESENCE_TTL_SECONDS` | `30` | |
| `RATE_LIMIT_PER_SEC` / `RATE_LIMIT_BURST` | `20` / `40` | Commands per socket |
| `CURSOR_RATE_PER_SEC` | `30` | |
| `REPLAY_MAX_EVENTS` | `500` | Replay window before falling back to a snapshot |

All people, emails and cards in the demo data are fictional (`@example.test`).

## License

[MIT](LICENSE) © Kevin Makwana
