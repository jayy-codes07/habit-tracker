/**
 * Tests for the test harness itself.
 *
 * Everything else that touches the database trusts these: that a test really
 * writes to Postgres, that nothing it writes survives, and that code using the
 * ordinary data access path is inside the test's transaction rather than
 * quietly committing beside it.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import express from "express";

import { query, withTransaction } from "../src/db/index.js";
import {
  closePool,
  makeHabit,
  makeLog,
  makeSchedule,
  withRollback,
  withRollbackServer,
} from "./helpers/db.js";

const ISOLATION_PROBE = "isolation-probe-habit";
const REENTRANCY_PROBE = "reentrancy-probe-habit";
const HTTP_PROBE = "http-request-probe-habit";

after(closePool);

describe("test database harness", () => {
  it("writes and reads real rows", async () => {
    await withRollback(async () => {
      const habit = await makeHabit({ name: ISOLATION_PROBE });
      assert.ok(habit.id, "insert returned no id");

      const { rows } = await query("SELECT name, start_date FROM habits WHERE id = $1", [habit.id]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, ISOLATION_PROBE);
      // The DATE parser override: a calendar date stays a string.
      assert.equal(typeof rows[0].start_date, "string");
    });
  });

  it("rolls back, so the previous test's rows are gone", async () => {
    await withRollback(async () => {
      const { rows } = await query("SELECT 1 FROM habits WHERE name = $1", [ISOLATION_PROBE]);
      assert.equal(rows.length, 0, "a previous test's row survived its rollback");
    });
  });

  it("leaves nothing behind outside a transaction either", async () => {
    // Runs on the pool, not the ambient client: this is what the database
    // actually contains between tests.
    //
    // Read this as a suite-wide invariant rather than a local assertion: NO test
    // file ever commits to habit_tracker_test. Every one either rolls back or,
    // like migrate-and-seed, works on its own scratch database. Node runs test
    // files concurrently in separate processes, so the moment some other file
    // commits a habit, this line fails — in this file, naming nothing that has
    // anything to do with the file that actually broke it. If that happens, the
    // bug is there and not here.
    const { rows } = await query("SELECT count(*)::int AS count FROM habits");
    assert.equal(
      rows[0].count,
      0,
      "the test database is not empty between tests — some test file committed instead of rolling back",
    );
  });

  it("puts withTransaction inside the test's transaction, not beside it", async () => {
    // The regression this guards: if withTransaction took its own pool
    // connection it would COMMIT independently, and the row would outlive the
    // rollback below — silently leaking state into every later test.
    await withRollback(async () => {
      const habit = await withTransaction(() => makeHabit({ name: REENTRANCY_PROBE }));
      const { rows } = await query("SELECT 1 FROM habits WHERE id = $1", [habit.id]);
      assert.equal(rows.length, 1);
    });

    const { rows } = await query("SELECT 1 FROM habits WHERE name = $1", [REENTRANCY_PROBE]);
    assert.equal(rows.length, 0, "withTransaction committed outside the test transaction");
  });

  it("gives fixtures valid defaults", async () => {
    await withRollback(async () => {
      const habit = await makeHabit();
      const { rows: schedules } = await query("SELECT * FROM habit_schedules WHERE habit_id = $1", [
        habit.id,
      ]);
      assert.equal(schedules.length, 1, "makeHabit should create one schedule by default");
      assert.equal(schedules[0].schedule_kind, "fixed");
      assert.equal(schedules[0].effective_from, habit.start_date);

      const log = await makeLog(habit.id);
      assert.equal(log.status, "done");
    });
  });

  it("can build a habit with no schedule when the test supplies its own", async () => {
    await withRollback(async () => {
      const habit = await makeHabit({ schedule: false });
      const { rows } = await query(
        "SELECT count(*)::int AS count FROM habit_schedules WHERE habit_id = $1",
        [habit.id],
      );
      assert.equal(rows[0].count, 0);

      await makeSchedule(habit.id, { schedule_kind: "weekly" });
      const { rows: after } = await query(
        "SELECT schedule_kind, weekly_target FROM habit_schedules WHERE habit_id = $1",
        [habit.id],
      );
      assert.equal(after[0].schedule_kind, "weekly");
      assert.equal(after[0].weekly_target, 3);
    });
  });
});

/**
 * A route that writes through the ordinary data access path — no client is
 * threaded in, exactly as a Step 4 controller will be written.
 */
function writingApp() {
  const app = express();
  app.post("/habits", async (_request, response) => {
    const { rows } = await query(
      `INSERT INTO habits (name, color_token, sort_order, start_date)
       VALUES ($1, 'chart-1', 0, '2026-01-05')
       RETURNING id, name`,
      [HTTP_PROBE],
    );
    response.status(201).json(rows[0]);
  });
  app.get("/habits/count", async (_request, response) => {
    const { rows } = await query("SELECT count(*)::int AS count FROM habits WHERE name = $1", [
      HTTP_PROBE,
    ]);
    response.json(rows[0]);
  });
  return app;
}

describe("HTTP requests inside the test transaction", () => {
  // The regression this guards is silent: before withRollbackServer existed,
  // the row below committed for real and survived the rollback, while the test
  // still passed. Every Step 4 route test depends on this staying true.
  it("contains a write made through a real HTTP request", async () => {
    let capturedBase;

    await withRollbackServer(writingApp, async ({ request, base, server }) => {
      assert.equal(server.listening, true, "server should be listening");
      capturedBase = base;

      const created = await request("/habits", { method: "POST" });
      assert.equal(created.status, 201);
      assert.equal((await created.json()).name, HTTP_PROBE);

      // Visible to the transaction that is about to be rolled back...
      const counted = await request("/habits/count");
      assert.equal((await counted.json()).count, 1, "the route could not see its own write");

      // ...and to a direct query on the same ambient client.
      const { rows } = await query("SELECT 1 FROM habits WHERE name = $1", [HTTP_PROBE]);
      assert.equal(rows.length, 1);
    });

    // ...and gone once it has been.
    const { rows } = await query("SELECT 1 FROM habits WHERE name = $1", [HTTP_PROBE]);
    assert.equal(rows.length, 0, "an HTTP-borne write escaped the rollback and committed");

    // The listener is genuinely gone, not merely dereferenced: nothing is left
    // holding the port open.
    await assert.rejects(fetch(`${capturedBase}/habits/count`));
  });

  it("closes the server and leaves no handle behind", async () => {
    let server;
    const before = process.getActiveResourcesInfo().filter((r) => r === "TCPSERVERWRAP").length;

    await withRollbackServer(writingApp, async (context) => {
      server = context.server;
      await context.request("/habits", { method: "POST" });
    });

    assert.equal(server.listening, false, "server still listening after the helper returned");
    const after = process.getActiveResourcesInfo().filter((r) => r === "TCPSERVERWRAP").length;
    assert.equal(after, before, "a listening socket leaked");
  });

  it("leaves the next test an empty database", async () => {
    // The same suite-wide invariant as above, checked after the HTTP path
    // specifically: no test file ever commits to habit_tracker_test.
    const { rows } = await query("SELECT count(*)::int AS count FROM habits");
    assert.equal(rows[0].count, 0, "a previous HTTP test committed rows");
  });

  it("gives each concurrent server its own port", async () => {
    // Port 0 asks the OS for a free port, so parallel test files cannot collide.
    // Two servers alive at once must therefore hold different ports.
    //
    // Note the nesting: withRollback is not reentrant, so these are two separate
    // transactions on two pooled connections, which is exactly what this test
    // wants. See the asymmetry documented on withRollback before nesting them
    // for any other reason.
    await withRollbackServer(writingApp, async (outer) => {
      await withRollbackServer(writingApp, async (inner) => {
        assert.notEqual(outer.base, inner.base, "two servers were given the same port");
        assert.equal(outer.server.listening, true);
        assert.equal(inner.server.listening, true);
      });
    });
  });
});

describe("updated_at trigger", () => {
  it("overwrites whatever the caller tried to store", async () => {
    await withRollback(async () => {
      const habit = await makeHabit();

      // now() is the transaction timestamp and does not advance inside one, so
      // an ordinary update could not be told apart from the insert. Writing an
      // obviously wrong value proves the trigger replaced it.
      const { rows } = await query(
        `UPDATE habits SET name = $2, updated_at = TIMESTAMPTZ '2000-01-01 00:00:00Z'
          WHERE id = $1
      RETURNING updated_at, updated_at = now() AS stamped_now`,
        [habit.id, "renamed"],
      );

      assert.equal(rows[0].stamped_now, true, "updated_at kept the value the caller supplied");
    });
  });
});
