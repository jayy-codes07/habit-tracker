# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Single-user, phone-first habit/task/journal tracker. Express 5 + Postgres 16 API in `server/`,
ESM only (`"type": "module"`), Node 20+. The SPA is in `web/` — React 19 + TypeScript + Vite +
Tailwind v4, its own npm project with its own lockfile. No workspaces, no root package.json.

Built in numbered steps; steps 1-4 (foundation, schema, auth, the feature API) are committed, and
step 5 is the SPA. A new feature router mounts in
[server/src/routes/index.js](server/src/routes/index.js), below the auth boundary.

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

The frontend runs on the host too — always. `npm run dev` serves it on :5173 and proxies `/api` to
the api container on :3000:

```bash
cd web && npm run dev           # also: typecheck, lint, lint:fix, format, format:check
cd web && npm run test:e2e      # Playwright; starts Vite itself, needs the api container up
```

`test:e2e` is the regression suite for the handful of failures that live above the API and that
no server test can see — a query cache that strands its observer, a tap that deletes a note, a
grid that overflows the page. It runs against the **development database** and writes to it; every
fixture it makes is named `E2E ` and swept before each test, because a test that times out is torn
down before its own cleanup finishes. Everything the server can be held to belongs in `npm test`
instead, which is faster and needs no browser.

`node --watch` in the api container does not always see edits through the bind mount (Docker
Desktop on Windows in particular). If a change to `server/src` is not showing up, the container is
still running the old code — `docker compose restart api`.

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

A module is only as many files as it needs: `health` and `export` have no service, because they
have no logic to put in one.

The modules, and why they are grouped this way:

- `habits/` owns habits, **schedule versions and logs too**. Neither has a life of its own — both
  are reached only through a habit and die with it — so splitting them would buy three routers and
  a lot of cross-importing for nothing. It also owns `GET /habits/:id/history`, which is a composed
  read but not an `overview/` one: it joins no other service, and the only scoring in it is the
  pure `dayVerdict` from `lib/`. It is the **one query that returns notes in bulk** (`loadNotes`),
  paged by a `before=<date>` cursor rather than an offset — `habit_logs` is unique on
  `(habit_id, date)`, so paging backwards is a scan of that index, and a page stays stable while
  the history behind it is being edited.
- `tasks/`, `journal/` — one table each.
- `overview/` owns `/day`, `/grid` and `/review`. It owns **no tables**: it composes the other
  services and the pure functions in `src/lib/`, which is what keeps the scoring rules in one
  place. Those endpoints are deliberately fat — a phone should paint a screen in one request.
- `export/` is the whole database as one JSON file. Raw rows only; anything derived can be
  recomputed, but a lost row is lost.

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

**Exactly two write paths need a transaction**, and both say so at the function: creating a habit
(a habit with no schedule version resolves to nothing on every date) and reordering (a rejected
reorder must write nothing). Everything else is a single statement, which Postgres already runs
atomically — wrapping one in `withTransaction` takes a connection out of a pool of ten and adds two
round trips to buy nothing. Read endpoints take none: a single user cannot race themselves.

Two single-statement patterns do real work here and are worth recognising:

- `INSERT ... SELECT FROM habits WHERE id = $1 ... ON CONFLICT DO UPDATE` — an unknown id yields
  zero rows instead of a foreign-key violation, so the caller gets a 404 with no extra existence
  check and nobody has to map SQLSTATE 23503.
- The `WITH victim AS (DELETE ... WHERE NOT EXISTS ...)` CTE in `deleteHabit`, which distinguishes
  204 / 409 / 404 from one snapshot. A check followed by a delete would leave a window where a log
  written between the two is destroyed by the cascade.

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
- `withApi()` in [tests/helpers/api.js](server/tests/helpers/api.js) wraps `withRollbackServer` with
  a logged-in request helper; everything past the auth boundary uses it.
- **No test may commit.** `db-harness.test.js` asserts the database is empty between tests and will
  fail in the *wrong* file if one does. Anything needing a real commit follows
  `migrate-and-seed.test.js` and uses its own scratch database.
- Most coverage is **pure**: `dates`, `scheduling` and `streaks` tests touch no database at all, so
  the nasty edge cases run in milliseconds with no fixtures. Reach for an HTTP test when the thing
  under test is the wiring, not the arithmetic.
- Adding a schema constraint means bumping the `cases.length` tripwire in `constraints.test.js`.

### Today comes from APP_TIMEZONE, never the server clock

`today()` in [src/lib/dates.js](server/src/lib/dates.js) is the single source of the current date,
resolved through `config.timezone` (`APP_TIMEZONE`, an IANA name, default `UTC`, validated at
config load so a bad value fails at boot). **Nothing outside `dates.js` calls `new Date()` to find
out what day it is.**

The container runs UTC. A server-clock "today" is therefore wrong for part of every day in any
other zone, and a habit tracker that decides the day wrongly reports broken streaks — the one
failure that destroys trust in the whole thing. `todayIn()` assembles the date from
`Intl.DateTimeFormat(...).formatToParts()` rather than slicing `format()`, which would be hostage
to ICU locale data.

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
  reintroduce `Date` objects for them. All date arithmetic lives in
  [src/lib/dates.js](server/src/lib/dates.js) and happens at noon UTC, so a DST transition can
  never push a result onto the neighbouring day. ISO date strings also compare lexicographically,
  so `a <= b` is a correct date comparison and needs no parsing.
- **`id` is a string everywhere.** Every id is `bigint`, and node-postgres returns bigint as a
  string — there is no type-parser override for oid 20, only for DATE. Ids stay strings through the
  API and back into query parameters; zod validates `/^\d+$/`, never `z.number()`.
- **Weekdays are ISO-8601**: 1 = Monday … 7 = Sunday, matching Postgres `ISODOW` and the product's
  Monday week start.
- **A habit does not carry its schedule.** `habit_schedules` holds dated versions; the schedule in
  force on day D is the greatest `effective_from <= D`, and only when `D >= habits.start_date`.
  Editing a schedule **appends a version**, so past weeks keep the meaning they had when they were
  lived. A change of **scoring unit** — fixed to weekly or back — is the one edit that does not start
  when it was asked to: `setSchedule` defers it to the **following Monday**, because fixed counts
  days and weekly counts weeks, and a switch landing on a Thursday leaves a week that is neither a
  complete fixed period nor a complete weekly one. Enforcing it once at the write is what keeps
  every scoring read free of a special case for it, and the stored `effective_from` comes back in
  the response so the client can say when the change starts. Everything else is immediate: a change
  of days only renames them, a change of target is already governed by the week's first active day,
  and pausing and resuming must take effect the moment they are asked for. Pausing is a version too (`schedule_kind = 'paused'`, no scheduled days), which is why a
  break reads as absence rather than failure: neutral in the grid, streaks pass through it, excluded
  from the consistency denominator. A paused version stores no days and no target, so **what a
  paused habit will resume to is not derivable from the version in force** — `resolveResumeSchedule()`
  walks back to the last version that asked for something, and `/habits` and `/day` both report it
  as `resumes_to`. Its forward-looking twin is `resolveNextSchedule()`, reported by `/habits` as
  `next_schedule`: the nearest version dated **strictly after** today, or null. Both are reported
  *alongside* `schedule`, never instead of it — a version that is in force, one that was
  interrupted and one that is waiting are three different claims, and the interface has to show
  more than one at a time. It exists because the client had to invent a schedule to resume on and invented
  every-day: resuming a Tue/Thu habit turned it into one that then failed five days a week. Never
  guess this on the client. It is null when a habit was paused from its first version, and also
  when the pause landed on the same `effective_from` as the schedule it replaced — `setSchedule`'s
  upsert genuinely destroys that version rather than hiding it.
- **A habit log has four states, not three**: `done` / `missed` / `skipped`, and *no row at all*
  meaning never logged — a distinct state that queries must preserve.
- `habits.color_token` is a theme token (`chart-1`…`chart-5`), never hex. `target_value`, `unit` and
  `habit_logs.value` are v2 quantity habits, NULL in v1.
- `updated_at` is stamped by a `BEFORE UPDATE` trigger on every table, never by callers.
- **Tasks are archived, never deleted.** There is no `DELETE /api/tasks/:id`. Consequently every
  task query must filter `archived_at IS NULL` — `tasks_due_date_open_idx` is partial on
  `WHERE NOT completed` and says nothing about archiving, so an archived open task would otherwise
  reappear as overdue for ever. That is a correctness requirement, not an optimisation.
- **Habits can be deleted only while they have no logs** (409 otherwise). Archive a history, delete
  a mistake.
- **An archived habit leaves the list at once, but never leaves the record.** `/day` drops it from
  today and from any later day the moment it is archived — it used to sit there, still tickable,
  until midnight, which reads as an archive that failed. Past days keep it, because the grid still
  paints those days and the two screens must not disagree about a day that was actually lived.
  `/grid` and `/review` keep it always and report `archived_on`, so a row that stops can say why:
  an unexplained stop reads as abandonment, and a habit retired mid-month spends its last days
  unlogged, which the review used to present as a 0% failure. The client compares `archived_on`
  against the **month's `end`**, never against today — a habit archived in September was alive all
  through July, and July has to keep reading the way it was lived.

### Streaks and consistency

Live in [src/lib/scheduling.js](server/src/lib/scheduling.js) and
[src/lib/streaks.js](server/src/lib/streaks.js) as **pure functions over rows already in memory** —
no queries, no fixtures, and therefore cheap to test exhaustively. Resolution is done in JavaScript
rather than SQL because every consumer needs it for a *range* of days: in SQL that is one lateral
subquery per (habit, day), ~840 for a twelve-week grid, against a handful of versions per habit.

Nothing is stored. Both are recomputed on every read, which is what makes retroactive edits simply
work — log a day you forgot and the streak that depended on it is correct immediately.

One shared verdict function, two streak algorithms. Not one generic one: fixed counts days, weekly
counts weeks, and unifying them would mean inventing a period abstraction for exactly two cases.

- `dayVerdict()` returns one of nine states. `missed` (you said so) and `unlogged` (no row at all)
  stay distinct all the way into the grid, because they are different claims.
- **Fixed streaks** break only on `missed` or `unlogged`. `skipped`, paused, unscheduled and bonus
  days pass through. An unlogged **today** is `future` and therefore neutral — an unticked habit at
  9am must never read as broken — but an *explicit* `missed` today does break it.
- **Weekly streaks** rest on one rule that resolves every mid-week case: a week that was not fully
  lived is **provisional — it can be satisfied, but it can never fail**. That covers the current
  week, a week a pause starts or ends in, and a week straddling the habit's start, all with the
  same arithmetic.
- A week's target is the one in force on its **first active, unpaused day**. So a target changed
  mid-week governs the following week: immune both to being raised on Saturday to punish and to
  being lowered on Sunday to rescue. Paused-ness is read from the schedule version, never from the
  verdict — a day worked during a pause reports `bonus`, not `paused`.
- **A change of schedule kind does not reset the streak.** Each period is scored under the kind
  that governed it, expressed in the current unit; a fixed-governed week is "met" when none of its
  scheduled days failed. Losing six months as a side effect of an edit is the worst thing this app
  could do.
- **Consistency is separate from the streak** and always reported alongside it. Skipped days leave
  the denominator entirely; paused days never enter it; a weekly week contributes its target with
  done days capped at it, so the rate cannot exceed 100%.
- `consistency()` has two loops and they must stay **disjoint**, or one calendar day is charged
  twice. The week loop therefore admits a week only when **no day in it is fixed-governed** — a week
  a weekly-to-fixed change split used to be billed as its weekly target *and* as the fixed days
  inside the same seven days. The Monday deferral above stops such a week being written at all; the
  guard is what keeps the sum honest for the rows written before it existed. The streaks are
  deliberately *not* this strict — they read a split week as the week it began as, because an edit
  must never cost a run.

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

Validation is `schema.parse(...)` inline in the controller and nothing else — Express 5 forwards a
rejected async handler on its own, and the handler already renders a `ZodError` as a 400. There is
deliberately **no `validate()` middleware**. Zod schemas live at the top of the controller that uses
them; only genuinely cross-module primitives (`idParam`, `isoDate`, `isoMonth`) go in
[src/lib/schemas.js](server/src/lib/schemas.js). `isoDate` carries a `.refine()` as well as a
pattern, because the pattern alone accepts `2026-02-31` — which Postgres would reject as a 500.

Throw `AppError` (or `badRequest` / `notFound` / `conflict` from [src/lib/errors.js](server/src/lib/errors.js))
for expected failures; the handler answers with that status and does **not** log 4xx, so real 500s
stay visible. Anything else reaching the handler is a bug and becomes a logged 500 (with `detail`
only outside production). A `ZodError` becomes a 400 carrying `path` and `message` only — never
`issue.input`, which would echo the rejected value back into the response.

### One origin, and the SPA

`mountSpa()` in [src/app.js](server/src/app.js) serves `web/dist` and returns the shell for any
non-API path. The Docker build context is the **repository root**, not `server/`, so the runtime
image can carry the SPA, and `docker-compose.yml` passes `WEB_STAGE=web-build` to select the stage
that builds it. Three consequences that have all bitten already:

- **The development container cannot serve the SPA, by design.** The override bind-mounts
  `server/` at `/app`, which shadows the image's `/app/web`, so `WEB_DIST_PATH` can never resolve
  and the placeholder is what you get. The override therefore passes `WEB_STAGE=web-empty` — there
  is no point spending a minute per rebuild on a directory nothing can reach. Vite on the host is
  the development frontend.
- **`mountSpa()` runs its `existsSync` once, inside `createApp()`.** Building `web/dist` against a
  running server changes nothing until the process restarts.
- **`web/package-lock.json` must stay committed.** The `web-build` stage runs `npm ci`.

Helmet's default CSP (`script-src 'self'`, `font-src 'self'`, `style-src … 'unsafe-inline'`) needs
no modification: Vite emits no inline `<script>`, the fonts are self-hosted, and React's inline
`style` attributes are covered. Do not add a CDN — `connect-src` falls back to `'self'` too.

### The SPA

Phone-first, and deliberately small: no component library, no state manager. Native elements do
the work a library would otherwise be installed for — `<dialog showModal>` for the sheet (focus
trap, Escape, backdrop, inert background), `<input type="date">`, and sr-only radios and checkboxes
behind styled labels so grouping and arrow-key navigation come from the platform.

`web/src` is laid out by domain, mirroring `server/src/modules/` so both halves of the app are
read with one map:

- `features/<name>/` — one folder per domain (`auth`, `habits`, `tasks`, `journal`, `overview`),
  each owning its `api.ts` (endpoints), `queries.ts` (TanStack hooks) and whatever domain logic and
  domain UI it has. `habits/` owns **schedules and logs too**, as the server's module does, which
  is why `useSetLog` lives there and not under `overview/`. `overview/` owns the composed screen
  reads — `/day`, `/grid` and `/review`, all three implemented — and no tables.
- `routes/` — one file per URL: `Day`, `Grid`, `Review`, `Habits`, `HabitHistory`, `Tasks`,
  `Login`. Route components compose features; features never import routes. `HabitHistory` is
  `/habits/:id`, one level below the list and the only screen about a single habit over its whole
  life rather than about a day, a week or a month — reached from a row on `/habits` and from a
  habit's name on `/grid`. It is also where the habit **editor** is opened from, so that changing a
  habit happens on the screen that shows what you would be changing; `/habits` rows no longer open
  it directly.
- `components/` — domain-free UI only (`Dialog`, `Choice`, `ErrorBox`, `Skeleton`, `icons`, and
  `form.ts`, the shared control classes). Anything that knows what a habit is belongs in `features/`.
- `lib/` — `api-client.ts` (the transport: `request`, `ApiError`; endpoints live with their
  feature), `dates.ts` and `invalidate.ts`.
- `types.ts` stays a single shared file at the root: it is the API's vocabulary, one payload
  references another, and splitting it per feature would only buy cross-imports. `index.css` is
  the single stylesheet, next to `main.tsx` that imports it.

**Today is not a screen.** It is `/day/:date` with the date set to today. Logging this morning and
fixing last Tuesday are the same job, so they are the same component — which is also why
`GET /api/day/:date` returns `today`: the client never consults its own clock, because the day
rolls over in `APP_TIMEZONE` and the browser may be somewhere else. `/` renders the browser's
date, then redirects to `data.today` if the server disagrees.

`/day`, `/grid` **and `/tasks`** therefore all carry `today`: a due date is only overdue relative
to a current date, so the tasks list has to be graded against the same one. The browser's clock
(`browserToday()`) may only choose which period a screen *opens* on — the day for `/`, the month
for `/review`. Opening on the wrong one is ambiguous for a few hours at a boundary and costs one
tap; grading against the wrong one puts a task under "Overdue" that `/day` still calls due.

Four payload traps, all handled in
[web/src/features/habits/verdict.ts](web/src/features/habits/verdict.ts) and documented there:

- **`scheduled` is true only for a fixed habit.** Weekly *and paused* habits report `false`, so
  `isActionable()` exists — grouping the day's list by `scheduled` would hide every weekly habit,
  every day.
- **`schedule_kind` means two things.** On `/habits` it is the stored kind (`fixed|weekly|paused`);
  on `/day`, `/grid` and `/review` it is `effectiveKind()`, which skips paused versions and can
  only be `fixed|weekly`. Hence `ScheduleKind` and `EffectiveKind` in `types.ts`.
- **Paused-ness is `paused`, never `verdict === "paused"`.** The verdict is a claim about the day
  and `dayVerdict()` checks `done` first, so a paused day that was worked reports `bonus` — reading
  the verdict lost the pause exactly when the habit had been ticked, and the day sheet then offered
  "Pause" on an already-paused habit with no way back. `/day` carries `paused` as a fact about the
  habit for this reason.
- **`done` and `done_of` do not pair up** (see the review payload). `done_of` is never rendered.

**The product states what happened; it does not keep records.** Counts, states and rates are facts
and all belong on screen — done, missed, skipped, not logged, paused days, consistency, attainment,
and the *current* streak, which says where you are. A **maximum** is not one of them: `longest_streak`
is on the review payload and is rendered nowhere, the habit history page reports no best month and
no personal record, and none should be added. A best is a high score in a game with one player, and
the moment a screen carries one, deciding to rest costs something — in an app whose entire scoring
model (skipped days leave the denominator, paused days never enter it, a pause passes through a
streak) exists to make rest cost nothing.

**A schedule change does not always start today, and the editor must say so.** Moving a habit
between fixed and weekly is stored effective the following Monday (see `setSchedule`), so
`HabitEditor` stays open on that one save and shows the `effective_from` the server returned.
Closing regardless dropped the person back on a list still resolving the schedule as of today —
a successful save that looked exactly like a failed one. Which saves *may* be deferred is decided
from the two schedule kinds, never from a date: the client may not consult its own clock to guess
one, and the date itself is always the `effective_from` the server returned. Once the dialog is
closed the same change is carried by `next_schedule` on the habit row, which is what makes it
survive a reload — the editor's panel renders the stored version if it has one and the just-saved
one otherwise, so there is one statement of it and it does not flicker in behind the refetch.

**Optimistic updates patch `status` only.** `verdict` and `streak` cannot be computed honestly on
the client — a streak needs history the client does not hold, and a paused day is indistinguishable
from an unscheduled one in the payload — so they are left to correct themselves on settle, and the
row's appearance is driven by `status`. There is no `localVerdict()` mirror, on purpose.

Invalidation is blunt and should stay that way: a log written last March can change today's streak,
this month's review and a grid cell a year back, so log mutations invalidate `["day"]`, `["grid"]`
and `["review"]` by prefix and everything else calls `invalidateAll`. Prefix invalidation is free —
TanStack only refetches queries that are mounted.

**A day's verdict is drawn by shape, never by two similar fills.** `paint()` in
[features/habits/verdict.ts](web/src/features/habits/verdict.ts) is the single implementation,
shared by the grid and by a habit's spine on its history page. Every day a habit was *alive* for
gets a tray (`--c-tray`); a bare tray means nothing was asked of you, `missed` is a **solid** ring
on it and `unlogged` a **dotted** one. `--c-tray` exists as its own token because `--c-line` sat
1.03:1 from the skipped fill, which made "skipped" and "nothing was asked" the same square. The
vocabulary was verified in greyscale in both themes down to an 11px cell, which is where the dotted
ring stops resolving — and that floor, not a layout limit, is why `/grid` offers no one-year range
below `md`.

Colour tokens are applied as `var(--c-${habit.color_token})`, not through a token-to-class map.
Note the `--c-` prefix: `@theme inline` in `index.css` does not emit `--color-*` custom properties,
it inlines them into the utilities it generates, so `var(--color-chart-1)` resolves to nothing.

## Conventions

- Prettier: 100 columns, double quotes, trailing commas. Run `npm run format` rather than
  hand-formatting; the `eslint-config-prettier` block stays last in the ESLint config.
- Unused-but-required function arguments (Express handler shapes) are marked with a leading `_`.
  The error handler must keep all four parameters — Express identifies it by arity.
- Comments here explain *why*, and load-bearing decisions are documented at the constraint or
  function that enforces them. Match that when adding code, and do not strip those comments.
