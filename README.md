# Habit Tracker

Personal habit, task and journal tracker. Phone-first, single user.

One origin in production: Express serves both `/api` and the built React SPA, which
is what lets the session cookie stay `SameSite=Lax` with no CORS.

## Requirements

Docker Desktop and Node 20+. No local Postgres needed - the database runs in Compose.

## Getting started

```bash
cp .env.example .env                 # then set the auth values, below
cd server && npm install && cd ..
docker compose up -d --build         # api on http://localhost:3000, db on 5432
docker compose exec api npm run db:migrate
docker compose exec api npm run db:seed
curl http://localhost:3000/api/health
```

Set the two auth values in `.env` before first run:

```bash
cd server
npm run hash-password                                 # prints AUTH_PASSWORD_HASH=...
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"  # SESSION_SECRET
```

`.env` is gitignored and must never be committed.

## Development

`docker compose up` merges `docker-compose.override.yml` automatically: the api
service bind-mounts `server/` and runs `node --watch`, so edits reload with no rebuild.

```bash
docker compose up -d                 # start (development)
docker compose logs -f api           # follow logs
docker compose exec api npm test     # run tests
docker compose down                  # stop, keeping data
docker compose down -v               # stop and DELETE the database volume
```

Lint and format run on the host rather than through `docker compose exec`: the api image
carries production dependencies only (`npm ci --omit=dev`), so eslint and prettier are not
installed in it. They come from the `npm install` above, in `server/node_modules`.

```bash
cd server
npm run lint          # also: lint:fix, format, format:check
npm run format:check
```

## Tests

Tests run against a separate database, `habit_tracker_test`, so a run can never
touch development data. `npm test` creates and migrates it first — there is no
manual setup step:

```bash
docker compose exec api npm test         # create/migrate the test database, then run
docker compose exec api npm run test:db  # just create and migrate it
```

The test database name is derived from `DATABASE_URL` by appending `_test`, or
set `TEST_DATABASE_URL` to choose it. Either way the name must end in `_test`:
the harness refuses to run against anything else.

Each test runs inside a transaction that is rolled back afterwards, so tests
cannot see each other's rows and leave nothing behind even when they fail. The
rollback wrapper and the fixture builders live in `tests/helpers/db.js`.

If a local PostgreSQL is already listening on 5432 it will shadow the container
for commands run on the host. Either run tests through `docker compose exec api`,
or set `POSTGRES_PORT` in `.env` to a free port.

To run the production-shaped stack locally - built image, no bind mounts, no dev
dependencies, `NODE_ENV=production`:

```bash
docker compose -f docker-compose.yml up --build
```

Note that `NODE_ENV=production` marks the session cookie `Secure`, so a browser
will not store it over plain http. That stack is for verifying the image, not for
logging in locally.

## Layout

```
server/
  src/
    app.js              Express assembly (middleware, routers, SPA)
    server.js           entrypoint: listen + graceful shutdown
    config/             environment loading and resolved paths
    db/                 pool, transactions, migration runner
      migrations/       numbered .sql, applied once, in order
      seeds/            deterministic development data
    middleware/         cross-cutting: require-auth, error-handler
    modules/            one folder per feature
      auth/             auth.routes | auth.controller | auth.service
      health/           health.routes | health.controller
    routes/index.js     API mount order and the auth boundary
    lib/                shared helpers: errors
  scripts/              operational scripts (hash-password)
  tests/
    helpers/            test database setup, rollback wrapper, fixtures
```

A feature owns its routes, controller and service in one folder. Adding a feature
means adding a folder and one line in `src/routes/index.js`.

## Database

Migrations are numbered SQL files applied in filename order, each inside a
transaction, recorded in `schema_migrations`. Re-running is a no-op. A failed
migration is never recorded, so it retries cleanly.

**Applied migrations are immutable.** `001_init.sql` was rewritten in place once,
while the project was still greenfield and no database held real data — that was
a deliberate one-off, and it is over. Now that it is committed and applied, it
must never be edited again: a database that has already run it would silently
keep the old schema, because `schema_migrations` records the filename and would
skip it. Every schema change from here on is a **new numbered migration**, even a
one-line one. There are no checksums enforcing this; the discipline is the
mechanism.

```bash
docker compose exec api npm run db:migrate
docker compose exec api npm run db:seed     # truncates and rebuilds dev data
```

Production uses a managed Postgres service. The `db` container is development only.

A habit does not carry its schedule. `habit_schedules` holds dated versions of
it, and the schedule in force on a day is the latest version starting on or
before that day. Editing a schedule appends a version rather than overwriting
one, so past weeks keep the meaning they had when they were lived instead of
being re-scored under today's rules. Pausing a habit is a version too
(`schedule_kind = 'paused'`), which is why a break for illness or travel reads as
absence rather than as failure.

A habit log is `done`, `missed` or `skipped`; no row at all means the day was
never logged, which is a distinct state from any of them.

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | public | liveness + database readiness (503 when the database is down) |
| `POST /api/login` | public | password -> session cookie; rate limited to 5 failures / 15 min |
| `POST /api/logout` | public | clears the cookie; safe to repeat |
| `GET /api/session` | required | whether the current cookie is still valid |

Everything mounted after `requireAuth` in `src/routes/index.js` needs the cookie.
