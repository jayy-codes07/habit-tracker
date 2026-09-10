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

In `server/`: `npm run lint`, `npm run format`, `npm test`.

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
    lib/                shared helpers
  scripts/              operational scripts (hash-password)
  tests/
```

A feature owns its routes, controller and service in one folder. Adding a feature
means adding a folder and one line in `src/routes/index.js`.

## Database

Migrations are numbered SQL files applied in filename order, each inside a
transaction, recorded in `schema_migrations`. Re-running is a no-op. A failed
migration is never recorded, so it retries cleanly.

```bash
docker compose exec api npm run db:migrate
docker compose exec api npm run db:seed     # truncates and rebuilds dev data
```

Production uses a managed Postgres service. The `db` container is development only.

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/health` | public | liveness + database readiness (503 when the database is down) |
| `POST /api/login` | public | password -> session cookie; rate limited to 5 failures / 15 min |
| `POST /api/logout` | public | clears the cookie; safe to repeat |
| `GET /api/session` | required | whether the current cookie is still valid |

Everything mounted after `requireAuth` in `src/routes/index.js` needs the cookie.
