# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Single-user, phone-first habit/task/journal tracker. Express 5 + Postgres 16 API in `server/`,
ESM only (`"type": "module"`), Node 20+. The React SPA (`web/`) does not exist yet — the server,
Dockerfile and config are already wired for it and stay inert until it does.

Built in numbered steps; steps 1-3 (foundation, schema, auth) are committed. Feature routers land
at the marked spot in [server/src/routes/index.js](server/src/routes/index.js).

## Commands

Anything that needs the database runs inside the api container. `docker compose up` merges
`docker-compose.override.yml` automatically, so plain `up` is the development stack (bind-mounted
source, `node --watch`).

```bash
docker compose up -d --build                    # api :3000, db :5432
docker compose logs -f api
docker compose exec api npm run db:migrate      # apply pending migrations
docker compose exec api npm run db:seed         # truncate + rebuild dev data
docker compose exec api npm test                # creates/migrates habit_tracker_test first
docker compose down -v                          # stop and DELETE the db volume
docker compose -f docker-compose.yml up --build # production-shaped: built image, no mounts
```

**Lint and format run on the host, not in the container**, and are the one exception to the rule
above:

```bash
cd server && npm run lint       # also: lint:fix, format, format:check
```

The api image is built from the `runtime` stage, whose deps stage runs `npm ci --omit=dev`, and the
override mounts an anonymous volume over `/app/node_modules` so the host mount cannot shadow the
image's. Both are deliberate — the development container carries production dependencies only — and
together they mean eslint and prettier are simply not installed in it. They live in the host's
`server/node_modules`, put there by the `npm install` in [README.md](README.md).

Run a single test file or a single test — `npm test`'s `pretest` hook is what creates and migrates
the test database, so run `npm run test:db` first if it may be stale:

```bash
docker compose exec api node --test --import ./tests/helpers/env.js tests/auth.test.js
docker compose exec api node --test --import ./tests/helpers/env.js --test-name-pattern "rate limit" tests/
```

The `--import ./tests/helpers/env.js` flag is mandatory: it repoints `DATABASE_URL` at the test
database before any module loads. Without it a run writes to development data.

Setup, auth-secret generation and the production-stack caveats are in [README.md](README.md).
A local Postgres listening on 5432 shadows the container for host-run commands — go through
`docker compose exec api`, or set `POSTGRES_PORT`.

## Architecture

### Feature modules and the auth boundary

A feature owns `<name>.routes.js` / `.controller.js` / `.service.js` in one folder under
`src/modules/`. Adding one means adding the folder and one line in
[src/routes/index.js](server/src/routes/index.js) — and **where** that line goes is
security-relevant: `router.use(requireAuth)` is the boundary, and everything mounted after it needs
the session cookie. Public routes go above it (which is why `/session` guards itself with an inline
`requireAuth`: it sits in the public auth router).

### Ambient transactions

[src/db/index.js](server/src/db/index.js) keeps the in-progress transaction client in an
`AsyncLocalStorage`. `query()` runs on that client when one is present and on the pool otherwise,
so no layer has to thread a client through. Consequences worth knowing before touching it:

- `withTransaction` is **reentrant and flattened** — a nested call joins the outer transaction
  rather than taking a second pooled connection (which would deadlock against the outer's locks).
- There are no savepoints, so a failed inner statement aborts the whole transaction, and catching
  the error does not make it usable again. A nested `withTransaction` is not something a caller can
  attempt and recover from.
- `runWithClient` exists for the test harness only; application code uses `withTransaction`.

### Tests: one rolled-back transaction each

[tests/helpers/db.js](server/tests/helpers/db.js) wraps each test in a transaction that is always
rolled back, so nothing commits and tests need no cleanup or truncation. Code under test reaches
that transaction through the ambient client above.

- For anything that touches the database **through an HTTP request**, use `withRollbackServer`,
  never `withRollback` plus a hand-rolled `listen()`. A server created outside the store serves
  requests with an empty async context, every `query()` in a route falls back to the pool, and the
  writes commit for real and survive the rollback — silently, with the test still green.
- Fixture builders (`makeHabit`, `makeSchedule`, `makeLog`, `makeTask`, `makeJournal`) take
  overrides and return the inserted row; override only the column the test is about.
- The test database name must end in `_test` — [tests/helpers/database-url.js](server/tests/helpers/database-url.js)
  refuses anything else. It is derived from `DATABASE_URL` unless `TEST_DATABASE_URL` is set.

### Config is a boot-time snapshot

[src/config/index.js](server/src/config/index.js) reads `process.env` when it is first imported,
and `src/db` builds its pool from that immediately. Two rules follow:

- A script needing a different `DATABASE_URL` must set it and then **dynamically** import `src/db`
  (see [tests/helpers/setup-test-db.js](server/tests/helpers/setup-test-db.js)).
- A test needing different auth settings mutates the live `config` object, not `process.env` (see
  the `before()` hook in [tests/auth.test.js](server/tests/auth.test.js)).

The single `.env` lives at the repo root next to `docker-compose.yml`; config loads `server/.env`
then the repo root, and real environment variables always win. `assertAuthConfig()` runs inside
`createApp()`, so a bad auth config fails at boot rather than at the first login — and `db:migrate`
and `db:seed` still run without auth values set.

### Migrations are immutable

Numbered `.sql` files in `src/db/migrations/`, applied in filename order, each in its own
transaction, recorded in `schema_migrations`; the runner takes a Postgres advisory lock so two
booting instances serialize. A failed migration is never recorded, so it retries cleanly.

**Never edit an applied migration.** `001_init.sql` was rewritten in place once while the project
was greenfield; that is over. `schema_migrations` records the filename, so an already-migrated
database would silently keep the old schema. Every schema change is a new numbered migration, even
a one-line one. Nothing enforces this but the discipline.

### Domain model

Read [001_init.sql](server/src/db/migrations/001_init.sql) before touching data logic — the rules
live in constraints, with the reasoning in comments.

- **Calendar days are `DATE`, never timestamps**; event instants are `TIMESTAMPTZ`. `src/db/index.js`
  overrides the node-postgres parser for oid 1082 so dates stay `'YYYY-MM-DD'` strings — do not
  reintroduce `Date` objects for them. Date arithmetic in the seed happens at noon UTC for the same
  reason.
- **Weekdays are ISO-8601**: 1 = Monday … 7 = Sunday, matching Postgres `ISODOW` and the product's
  Monday week start.
- **A habit does not carry its schedule.** `habit_schedules` holds dated versions; the schedule in
  force on day D is the greatest `effective_from <= D`, and only when `D >= habits.start_date`.
  Editing a schedule **appends a version**, so past weeks keep the meaning they had when they were
  lived. Pausing is a version too (`schedule_kind = 'paused'`, no scheduled days), which is why a
  break reads as absence rather than failure: neutral in the grid, streaks pass through it, excluded
  from the consistency denominator.
- **A habit log has four states, not three**: `done` / `missed` / `skipped`, and *no row at all*
  meaning never logged — a distinct state that queries must preserve.
- `habits.color_token` is a theme token (`chart-1`…`chart-5`), never hex. `target_value`, `unit` and
  `habit_logs.value` are v2 quantity habits, NULL in v1.
- `updated_at` is stamped by a `BEFORE UPDATE` trigger on every table, never by callers.

### Auth

Single user: no users table, no user id, no server-side session state. The signed cookie *is* the
session, so restarts and multiple instances need no coordination.

- scrypt from `node:crypto` (memory-hard, no native module). The stored format is
  `scrypt.n=…,r=…,p=….<salt>.<hash>` in base64url — deliberately **not** the PHC `$scrypt$…`
  convention, because `$` would be eaten by `.env` files, Compose interpolation and shells.
  Parameters travel with the hash, so they can be raised without invalidating it.
- `SameSite=Lax` with no CORS is only correct because one origin serves both `/api` and the SPA.
  Keep it that way. `Secure` is read at call time from `config.env`, so `NODE_ENV=production`
  locally means a browser will not store the cookie over plain http.
- The login rate limiter is built **per app instance** (`createAuthRouter()`), so tests do not leak
  attempt counts into each other. Brute force is the only realistic attack on a one-password app.
- Auth failures are one generic message and reflect nothing back — no zod validation, no echo of the
  submitted value, never logged.

### Errors

Throw `AppError` (or `badRequest` / `notFound` / `conflict` from [src/lib/errors.js](server/src/lib/errors.js))
for expected failures; the handler answers with that status and does **not** log 4xx, so real 500s
stay visible. Anything else reaching the handler is a bug and becomes a logged 500 (with `detail`
only outside production). A `ZodError` becomes a 400 carrying `path` and `message` only — never
`issue.input`, which would echo the rejected value back into the response.

### One origin, and the SPA

`mountSpa()` in [src/app.js](server/src/app.js) serves `web/dist` and returns the shell for any
non-API path; until that build exists it serves a plain-text placeholder. The Docker build context
is the **repository root**, not `server/`, so the runtime image can carry the SPA. Once `web/`
exists, build with `--build-arg WEB_STAGE=web-build`; the default `web-empty` stage keeps the
missing directory out of the build graph.

## Conventions

- Prettier: 100 columns, double quotes, trailing commas. Run `npm run format` rather than
  hand-formatting; the `eslint-config-prettier` block stays last in the ESLint config.
- Unused-but-required function arguments (Express handler shapes) are marked with a leading `_`.
  The error handler must keep all four parameters — Express identifies it by arity.
- Comments here explain *why*, and load-bearing decisions are documented at the constraint or
  function that enforces them. Match that when adding code, and do not strip those comments.
