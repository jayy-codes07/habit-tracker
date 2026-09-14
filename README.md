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

## Frontend

The SPA lives in `web/` (React + TypeScript + Vite + Tailwind). It runs on the **host**,
not in a container, and proxies `/api` to the Compose api service:

```bash
cd web && npm install        # once
npm run dev                  # http://localhost:5173, /api proxied to :3000
npm run typecheck            # also: lint, lint:fix, format, format:check
```

The api container cannot serve the SPA in development, and is not meant to. The dev override
bind-mounts `server/` at `/app`, which shadows the image's `/app/web`, so `WEB_DIST_PATH`
resolves to a directory that cannot exist and `mountSpa()` serves its plain-text placeholder.
Vite on the host is the development frontend; the container is the API.

The dev cookie works because the API sets it with no `Domain`, so it scopes to host
`localhost` and cookies ignore the port. Through the proxy the browser sees one origin, which
is what `SameSite=Lax` needs.

Two things about the production path:

- `web/package-lock.json` **must be committed** — the Dockerfile's `web-build` stage runs
  `npm ci`, which fails without it. Leave `build.outDir` alone: Vite's default `dist` is
  already `web/dist`, which is what `WEB_DIST_PATH` expects.
- `mountSpa()` checks for `web/dist/index.html` **once, when the app is created**. Building
  the SPA against a running server changes nothing until that process restarts.

`docker-compose.yml` passes `WEB_STAGE=web-build`, so a production-shaped image carries the
SPA; the dev override passes `web-empty`, because that container could not serve it anyway.

```bash
docker compose -f docker-compose.yml up --build   # production-shaped, SPA included
```

That stack sets `NODE_ENV=production`, which makes the session cookie `Secure` — so a browser
will not store it over plain http and **you cannot log in there**. It is good for checking
that the assets build and are served; sign-in has to be tested through the dev setup or
behind real TLS.


## Time zone

`APP_TIMEZONE` (an IANA name, default `UTC`) decides what day it currently is. A habit is done on a
day, not at an instant, and the container runs UTC - so without this the day rolls over at midnight
UTC and streaks read wrongly for part of every day anywhere else. An invalid zone fails at boot
rather than as a 500 on the first request.

Everything that needs today's date goes through `today()` in `src/lib/dates.js`. Nothing else calls
`new Date()` to find out what day it is.

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

web/
  src/
    main.tsx            entry: QueryClient, the global 401 handler, router
    index.css           design tokens, both themes, the sheet
    App.tsx             session gate, routes, the tab bar
    types.ts            the API's payloads, by hand
    features/           one folder per domain, mirroring server/src/modules/
      auth/             api | queries
      habits/           api | queries | schedule | verdict, and the habit dialogs
      tasks/            api | queries
      journal/          api | queries — day notes and the monthly reflection
      overview/         api | queries for /day, /grid and /review; owns no tables
    routes/             one file per URL: Day, Grid, Review, Login
    components/         domain-free UI: Dialog, Choice, ErrorBox, Skeleton,
                        icons, form.ts (the shared control classes)
    lib/                api-client.ts (transport), dates.ts, invalidate.ts
```

A feature owns its routes, controller and service in one folder. Adding a feature
means adding a folder and one line in `src/routes/index.js`.

The SPA mirrors that split: a feature owns its `api.ts`, `queries.ts` and its own
domain UI, `routes/` compose features, and features never import routes. `habits/`
owns schedules and logs too, exactly as the server module does.

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

### Habits

| Route | Purpose |
|---|---|
| `GET /api/habits?include=archived` | habits in display order, each with the schedule in force today |
| `POST /api/habits` | habit + its first schedule version |
| `PATCH /api/habits/:id` | `name`, `color_token`, `archived` |
| `DELETE /api/habits/:id` | 204, or **409 if it has any logs** - archive a history, delete a mistake |
| `PUT /api/habits/order` | `{ ids: [...] }`, the complete list of active habits |
| `POST /api/habits/:id/schedule` | appends a version; `effective_from` defaults to today and may not be in the past |
| `PUT /api/habits/:id/logs/:date` | `{ status, note? }` where status is `done` / `missed` / `skipped` |
| `DELETE /api/habits/:id/logs/:date` | removes the row, returning the day to *never logged* |

A schedule change re-posted on the same `effective_from` **overwrites** that version rather
than colliding, so a schedule mistyped a minute ago can be corrected. Backdating one is refused:
that would re-score history.

### Tasks and journal

| Route | Purpose |
|---|---|
| `GET /api/tasks?scope=open\|all` | open tasks by default; never archived ones |
| `POST /api/tasks` | `{ title, due_date? }` |
| `PATCH /api/tasks/:id` | `title`, `due_date` (null clears it), `completed`, `archived` |
| `PUT\|DELETE /api/journal/day/:date` | the daily one-liner |
| `PUT\|DELETE /api/journal/month/:yyyy-mm` | the monthly reflection, anchored to the 1st |

**Tasks have no DELETE.** Removal is `PATCH { archived: true }`, so nothing a single tap does is
irreversible and the export stays complete. Journal entries cannot be blank, so *clearing* one is
a `DELETE`.

### Screens

| Route | Purpose |
|---|---|
| `GET /api/day/:date` | habits + status + streaks, tasks due and overdue, the day's journal entry |
| `GET /api/grid?end=&weeks=` | the consistency grid; `weeks` 1-53, default 12, `end` defaults to today |
| `GET /api/review/:yyyy-mm` | per-habit consistency and streaks, task counts, the month's journal |
| `GET /api/export` | every table as one JSON file, archived rows included |

`/api/day` and `/api/grid` are deliberately fat: a phone should paint a screen from one request,
not five.

The grid is **always whole Monday-to-Sunday weeks**. It ends on the Sunday of the week containing
`end` and starts `weeks - 1` weeks before that week's Monday, so every row is exactly `weeks * 7`
characters and a cell can be indexed by offset. Each habit's `cells` string uses one character per
day:

| | | | |
|---|---|---|---|
| `d` done | `m` missed (explicitly) | `u` unlogged (past, scheduled, no row) | `s` skipped |
| `p` paused | `.` not scheduled | `f` not yet due (today or later) | `b` bonus (done unscheduled) |
| `-` inactive (before it started, or after it was archived) | | | |

`m` and `u` stay distinct because they are different claims: one is a day you looked at and
admitted missing, the other a day you never opened the app.

### Streaks and consistency

Nothing is stored; both are recomputed on every read, which is what makes retroactive edits just
work. The rules:

- **Fixed habits** count consecutive scheduled days. `skipped`, paused days and unscheduled days
  all pass through without breaking anything. An unlogged **today** is not yet due, so a habit
  unticked at 9am never reads as broken - but a day explicitly marked `missed` does break it,
  today included.
- **Weekly habits** count consecutive weeks meeting target. A week that was not fully lived - the
  current one, one a pause starts or ends in, one straddling the habit's start - is
  **provisional**: it can be satisfied, but it can never fail.
- A week's target is the one in force on its **first active day**, so changing a target mid-week
  governs the following week. That is immune both to raising it on Saturday and to lowering it on
  Sunday.
- Changing a habit between fixed and weekly does **not** reset the streak. Each period is scored
  under the schedule that actually governed it.
- **Consistency** is separate: `done / (scheduled - skipped)` over a window. Skipped days leave the
  denominator entirely, paused days never enter it, and a weekly week contributes its target with
  done days capped at it, so the rate can never exceed 100%.
