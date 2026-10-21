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
- [x] ~~**Real magic-link email**~~ (2026-10-20)
  - `Mailer` interface: `ConsoleMailer` (default, prints the email) and `SmtpMailer` (nodemailer, when `SMTP_URL` is set; `MAIL_FROM` for the sender). Magic links and board invitations are emailed; a send failure is logged and never changes the response or fails the invite
  - Verified: 9 unit tests (including real message rendering through a stream transport) and 5 integration tests through the real routes. Not tested against a live SMTP server
- [x] ~~**Observability**~~ (2026-10-20)
  - pino JSON logs in production (text in dev), request logging without query strings, `/ready` (Postgres + Redis, 2 s deadline, 503 on failure), `/metrics` (Prometheus: process, HTTP, sockets, commands by outcome), nginx proxies `/ready` and 404s `/metrics`, compose healthchecks use `/ready`
  - Verified: unit + integration tests, and the scale profile (healthy via `/ready`, JSON logs, `/metrics` reachable in the container only)
  - Used `@prometheus-io/client` because `prom-client` is deprecated in its favour
- [x] ~~**Heal lost broadcasts**~~ (2026-10-20)
  - A live client re-joins with its last seq every ~30 s (+ jitter) and when the tab becomes visible; a repeated join from a socket already on the board is now a resync on the server (keeps presence, no roster rebroadcast)
  - Verified: 6 client unit tests, 2 server tests, and a real-client integration test that commits a change without broadcasting it and watches the client catch up

### Phase 3: Product depth
- [x] ~~**Column reorder**~~ (2026-10-20)
  - `column:move` command answered with the existing `column.updated` event (no new reducer case); collisions get a fresh key, a move to the same place writes nothing; drag a column header, with a drop marker. Verified: shared, server (two instances), client unit and an e2e across two instances
- [x] ~~**Board rename and delete**~~ (2026-10-20)
  - Owner only. Rename is `board:rename` + `board.renamed` (live, in the log); delete is `DELETE /api/boards/:id` under the board lock, cascades, and cuts every member off. Found and fixed a connection leak in `getSnapshot` for missing boards on the way. Verified incl. delete-waits-for-in-flight-command and an e2e
- [x] ~~**Comment edit and delete**~~ (2026-10-20)
  - `comment:edit` (author only) and `comment:delete` (author or board owner), `comment.updated`/`comment.deleted` events, migration 3 (`edited_at`), inline editor and "(edited)" marker. Verified: server matrix, client unit, e2e with moderation
- [x] ~~**Card assignees, labels, due dates**~~ (2026-10-20)
  - Extra optional fields on `card:update` (same version check, same `card.updated` event), migration 4 (`due_date date`, `assignee_ids uuid[]`, `labels text[]`); assignees must be board members; old log entries are normalised on replay. Card modal editors (date, label chips, member checkboxes), tile badges (overdue/today), live for everyone. Verified: shared, server matrix, client unit, e2e incl. a read-only viewer
- [x] ~~**Activity feed UI**~~ (2026-10-20)
  - `GET /api/boards/:id/activity` turns `board_events` into readable lines (a pure `describeActivity` in `packages/shared` remembers titles and column names, so "deleted a card" still names it; it looks back 500 events and knows the default columns, which are seeded without events). Side panel in the board header, reloads (debounced) whenever the board's seq moves. Verified: shared unit tests, server int tests (limit, viewer, non-member), e2e with two users
- [x] ~~**Search**~~ (2026-10-20)
  - Client-side: a header box filters cards by every word across title, description, labels, assignee names and comments; columns show `matches/total`. Dragging cards is off while a search is active (drop positions assume every card is shown). Verified: unit tests for the matcher, e2e incl. a card arriving live while searching

### Phase 4: Hardening and scale
- [x] ~~**Frontend component tests and REST route tests**~~ (2026-10-21)
  - React Testing Library + jsdom as a `components` vitest project (run by `test:unit`): 50 tests over BoardView (search, activity, roles, card deleted while open), CardModal, Column and CardTile, driven with a spy client. `apps/web/test` is now typechecked
  - `routes.int.test.ts` (24 tests): every protected route needs a token, malformed ids, name/cursor/limit validation, stranger 404s, unknown routes, dev-login off, sign-in validation
  - Found and fixed: malformed JSON, oversized bodies and unsupported charsets/encodings answered 500 (and logged an error); now 400, 413 and 415
- [x] ~~**Touch and keyboard drag and drop, ARIA pass**~~ (2026-10-21)
  - Alt+arrows on a card (pure `cardMoveTarget`), move-left/right buttons on column headers, a Column + Position select in the card dialog (the touch path: no native touch drag was built, because browsers do not fire HTML5 DnD for touch and a pointer-events drag cannot be verified without a device), a polite live-region announcement and focus kept on what moved
  - ARIA: column name is a real button (keyboard rename, no more `biome-ignore`), dialogs focus in, trap Tab and restore focus (`useDialogFocus`), shortcut help via `aria-describedby`; axe-core runs over the board, card dialog and share dialog (colour contrast is not covered: it needs a real browser)
  - Also fixed: Activity/Share buttons had white text on a white background, and the assignee checkboxes were stretched to full width
  - Verified: unit (moves, tile, column, modal, board, axe), e2e `keyboard.spec.ts` across two instances
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
