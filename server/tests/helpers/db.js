/**
 * Database test harness: one transaction per test, always rolled back, plus
 * fixture builders so tests state what they need rather than how to insert it.
 *
 * Isolation comes from the rollback, not from cleaning up afterwards. Nothing a
 * test writes is ever committed, so tests cannot see each other's rows, cannot
 * leave anything behind when they fail, and do not need truncation between them.
 */
import { once } from "node:events";

import { pool, query, runWithClient } from "../../src/db/index.js";
import { assertTestDatabase } from "./database-url.js";

/**
 * The guard, rather than the documentation of one.
 *
 * `--import ./tests/helpers/env.js` is what repoints DATABASE_URL at the test
 * database, and nothing used to check that it had actually run. Without the flag
 * src/config resolves the development URL, the pool connects to it, and every
 * fixture below writes there. Those writes still roll back, so the damage was
 * bounded — but the only thing standing between the suite and real data was a
 * sentence in a document, and one TRUNCATE added to this file for a good local
 * reason would have turned a forgotten flag into destroyed data.
 *
 * Checking the pool's own connection string is the point: assertTestDatabase in
 * database-url.js validates the URL it *derives*, which says nothing about the
 * one the harness is actually connected to. This runs on import, so every test
 * file that reaches the database is covered by reaching it through this module.
 */
try {
  assertTestDatabase(pool.options.connectionString);
} catch (error) {
  throw new Error(
    `${error.message}\nRun the suite with \`npm test\`, or pass ` +
      "`--import ./tests/helpers/env.js` when invoking node --test directly.",
    { cause: error },
  );
}

/**
 * Runs `run` inside a transaction that is always rolled back.
 *
 * The client is installed as the ambient transaction client, so `query()` — and
 * anything built on it, including application services — joins this transaction
 * without being handed the client explicitly. That is the whole point: the code
 * under test uses its normal data access path and still gets rolled back.
 *
 * Deliberately NOT reentrant, which is the opposite of withTransaction: a nested
 * withRollback takes a second pooled connection and opens a second, independent
 * transaction rather than joining this one. That asymmetry is intentional —
 * nesting here means "I want two separate transactions", which is what the
 * concurrent-server test wants — but it has a sharp edge worth knowing before
 * you nest them. The inner transaction cannot see uncommitted rows from the
 * outer, so an inner insert referencing a row the outer just created fails on a
 * foreign key, and it fails looking like a bug in the code under test rather
 * than like the isolation level doing exactly its job.
 */
export async function withRollback(run) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    return await runWithClient(client, () => run(client));
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/**
 * The same transaction, with an HTTP server that can see it.
 *
 * Use this — never withRollback plus a hand-rolled listen() — for anything that
 * reaches the database through a request.
 *
 * An incoming connection does not inherit the async context of whoever calls
 * fetch(); it inherits the context in which the server's handle was created. A
 * server started outside the transaction therefore serves requests with an empty
 * store, every query() inside a route falls back to the pool, and the writes
 * commit for real and outlive the rollback — silently, with the test still
 * green. Creating the listener inside the store is the whole fix, and it is why
 * this helper owns both halves: the broken ordering is not expressible through
 * it.
 *
 * `createApp` must return an Express app (or any http.Server factory input);
 * `run` receives a bound `request(path, options)` plus the transaction client.
 */
export async function withRollbackServer(createApp, run) {
  return withRollback(async (client) => {
    // Inside the store, so the handle — and every connection it accepts —
    // inherits the transaction context.
    const server = createApp().listen(0);
    await once(server, "listening");

    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      return await run({
        request: (path, options) => fetch(`${base}${path}`, options),
        base,
        server,
        client,
      });
    } finally {
      await closeServer(server);
    }
  });
}

/**
 * Closes a test server and its sockets.
 *
 * close() alone only stops new connections; fetch keeps its socket alive, so the
 * callback would wait for an idle timeout and leave a live handle behind in the
 * meantime. Killing the connections first makes shutdown immediate and complete.
 */
export async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

/** Closes the pool so the test process can exit. Call from a file-level after(). */
export function closePool() {
  return pool.end();
}

// ---------------------------------------------------------------------------
// Fixtures
//
// Every builder takes overrides and returns the inserted row. Defaults are
// valid and boring; a test overrides only the column it is actually about.
// ---------------------------------------------------------------------------

let counter = 0;
const nextName = (prefix) => `${prefix} ${(counter += 1)}`;

/** A Monday, so weekday arithmetic in tests starts somewhere predictable. */
export const DEFAULT_START_DATE = "2026-01-05";

export const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

/**
 * Inserts a habit and, unless `schedule: false`, one schedule version starting
 * on its start_date — a habit with no schedule resolves to nothing and is not a
 * useful default.
 */
export async function makeHabit({ schedule = {}, ...overrides } = {}) {
  const row = {
    name: nextName("Habit"),
    color_token: "chart-1",
    sort_order: 0,
    start_date: DEFAULT_START_DATE,
    archived_at: null,
    ...overrides,
  };

  const { rows } = await query(
    `INSERT INTO habits (name, color_token, sort_order, start_date, archived_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [row.name, row.color_token, row.sort_order, row.start_date, row.archived_at],
  );
  const habit = rows[0];

  if (schedule !== false) {
    await makeSchedule(habit.id, { effective_from: habit.start_date, ...schedule });
  }
  return habit;
}

/** Defaults follow the kind, so `{ schedule_kind: 'weekly' }` alone is valid. */
export async function makeSchedule(habitId, overrides = {}) {
  const kind = overrides.schedule_kind ?? "fixed";
  const row = {
    effective_from: DEFAULT_START_DATE,
    schedule_kind: kind,
    schedule_days: kind === "fixed" ? EVERY_DAY : null,
    weekly_target: kind === "weekly" ? 3 : null,
    ...overrides,
  };

  const { rows } = await query(
    `INSERT INTO habit_schedules
       (habit_id, effective_from, schedule_kind, schedule_days, weekly_target)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [habitId, row.effective_from, row.schedule_kind, row.schedule_days, row.weekly_target],
  );
  return rows[0];
}

export async function makeLog(habitId, overrides = {}) {
  const row = {
    date: DEFAULT_START_DATE,
    status: "done",
    value: null,
    note: null,
    ...overrides,
  };

  const { rows } = await query(
    `INSERT INTO habit_logs (habit_id, date, status, value, note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [habitId, row.date, row.status, row.value, row.note],
  );
  return rows[0];
}

export async function makeTask(overrides = {}) {
  const row = {
    title: nextName("Task"),
    due_date: null,
    completed: false,
    completed_at: null,
    archived_at: null,
    ...overrides,
  };

  const { rows } = await query(
    `INSERT INTO tasks (title, due_date, completed, completed_at, archived_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [row.title, row.due_date, row.completed, row.completed_at, row.archived_at],
  );
  return rows[0];
}

export async function makeJournal(overrides = {}) {
  const row = {
    date: DEFAULT_START_DATE,
    kind: "day",
    entry: "A day happened.",
    ...overrides,
  };

  const { rows } = await query(
    "INSERT INTO journal (date, kind, entry) VALUES ($1, $2, $3) RETURNING *",
    [row.date, row.kind, row.entry],
  );
  return rows[0];
}

/**
 * Resolves the schedule in force on `date`, by the rule documented on
 * habit_schedules: the latest version that has started, and nothing before the
 * habit's own start_date.
 */
export async function scheduleOn(habitId, date) {
  const { rows } = await query(
    `SELECT s.*
       FROM habit_schedules s
       JOIN habits h ON h.id = s.habit_id
      WHERE s.habit_id = $1
        AND s.effective_from <= $2
        AND $2 >= h.start_date
      ORDER BY s.effective_from DESC
      LIMIT 1`,
    [habitId, date],
  );
  return rows[0] ?? null;
}
