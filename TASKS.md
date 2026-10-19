# Tasks

## Active

### Phase 1: Quick wins
- [x] ~~**HTTP hardening**~~ (2026-10-15)
  - Redis-backed limiter on `/api/auth/*` (per IP) and on magic links (per email); helmet; `TRUST_PROXY`; production refuses the dev `JWT_SECRET`
  - Verified: 4 config + 6 integration tests, and the compose scale profile boots and returns 429 behind nginx with real client IPs
  - Compose now reads `COMPOSE_JWT_SECRET` because the dev `.env` secret would otherwise reach the production container
  - Files: apps/server/src/app.ts, config.ts, httpRateLimit.ts, docker-compose.yml
- [x] ~~**Lint and format**~~ (2026-10-15)
  - Used Biome instead of ESLint + Prettier: typescript-eslint supports TypeScript <6.1 only and this repo is on 7.0.2
  - `npm run lint` (biome ci), `lint:fix`, `format`, `audit:prod` are wired into CI; the codebase was formatted once and lint findings fixed
  - Intentionally relaxed: `noNonNullAssertion`, `useTemplate`, `noAutofocus`, `noExplicitAny` in tests. Two a11y rules are suppressed with reasons (Column heading rename, card modal backdrop)
  - Known: 1 low-severity dev-only esbuild advisory under tsup (Windows dev server); the CI gate covers production deps at high and above
- [x] ~~**Scope idempotency checks to board_id**~~ (2026-10-15)
  - `createCard`, `createColumn`, `addComment` now go through `isRetry`: same id on the same board is a no-op retry; the same id on another board is refused with `VALIDATION` and writes no event
  - Verified: 5 tests in apps/server/test/idempotency.int.test.ts (3 failed first for the right reason)
- [x] ~~**Fix the offline notice**~~ (2026-10-15)
  - Copy now says the change was not saved (and is an `error` notice), instead of promising it will resume. The real offline queue stays in Phase 4
  - Verified: new unit test in apps/web/test/boardClient.test.ts (failed first), file apps/web/src/lib/boardClient.ts

### Phase 2: Safe to expose
- [x] ~~**Board membership and roles**~~ (2026-10-19)
  - `board_members` + `board_invites` (migration 2, owner backfill), owner/editor/viewer, invite by email claimed at sign-in, role re-checked inside every command's board-locked transaction, live revocation across instances via `serverSideEmit`, Share dialog and read-only viewer mode
  - Spec: docs/superpowers/specs/2026-10-18-board-membership-design.md; plan: docs/superpowers/plans/2026-10-19-board-membership.md
  - Verified: 59 unit, integration (membership, members, REST matrix, two-instance access), 4 e2e including a sharing flow
- [ ] **Real magic-link email** - provider interface with a console fallback for dev; configurable via env
  - Priority 28 (I4 R3 E2). Files: apps/server/src/auth.ts, app.ts
- [ ] **Observability** - structured logging (replace `console.log` logger), `/ready` that checks Postgres + Redis (keep `/health` as liveness), basic metrics endpoint
  - Priority 32 (I4 R4 E2). Files: apps/server/src/logger.ts, app.ts, docker-compose.yml healthchecks
- [ ] **Heal lost broadcasts** - periodic or on-focus head-seq check so a client notices a missed event on a quiet board (today a hole is only noticed when a later event arrives)
  - Priority 24 (I3 R3 E2). File: apps/web/src/lib/boardClient.ts. Add an integration test that drops one emit

### Phase 3: Product depth
- [ ] **Column reorder** - new `column:move` event: schema in events.ts, service method, gateway line, reducer case, UI drag
- [ ] **Board rename and delete** - new events or REST routes; owner-only once membership lands
- [ ] **Comment edit and delete** - new events, author-only
- [ ] **Card assignees, labels, due dates** - extend `cardSchema` and the migrations
- [ ] **Activity feed UI** - the data already exists in `board_events`
- [ ] **Search** - cards and comments within a board

### Phase 4: Hardening and scale
- [ ] **Frontend component tests and REST route tests** - React Testing Library for the board and card modal; route tests for app.ts
  - Priority 24 (I3 R3 E2)
- [ ] **Touch and keyboard drag and drop, ARIA pass** - HTML5 DnD in Column.tsx does not work on touch or keyboard
  - Priority 21 (I4 R3 E3)
- [ ] **Offline command queue** - real queue and replay, if wanted after the copy fix
- [ ] **CD, image publish, deploy guide** - publish images from CI; add docs for a production deploy
  - Priority 18 (I3 R3 E3)
- [ ] **Paging for boards and comments; throttle presence rebroadcasts** - `listBoards` is capped at 100; comments all load with the snapshot; `presence:editing` rebroadcasts the full roster. Also fix the read-modify-write race in `Presence.setEditing`
  - Priority 16 (I2 R2 E2)
- [ ] **Event-log retention or compaction** - periodic snapshots, prune old `board_events`
  - Priority 15 (I2 R3 E3)
- [ ] **Load test** - k6 or artillery against the scale profile to back the README scaling claims
- [ ] **Consider websocket-only transport** - would remove the nginx sticky-session hashing, at the cost of no polling fallback

## Waiting On

## Someday

## Done
