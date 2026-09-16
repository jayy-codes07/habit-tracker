/**
 * Backup and restore.
 *
 * The test that matters is the round trip, and it is the only one that can be
 * trusted: build a representative record, export it, throw the database away,
 * import the file, export again and require the two documents to be identical.
 * Anything short of that — asserting counts, spot-checking a habit — proves
 * that a restore ran, not that nothing was lost in it.
 *
 * "Throw the database away" is real here. The rollback harness wraps each test
 * in a transaction, so the restore's own TRUNCATE runs inside it and unwinds
 * with everything else.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  closePool,
  makeHabit,
  makeJournal,
  makeLog,
  makeProblem,
  makeSchedule,
  makeTask,
} from "./helpers/db.js";
import { json, withApi } from "./helpers/api.js";

after(closePool);

/**
 * One of everything the document carries, with the awkward cases in it on
 * purpose: an archived habit, a paused version, a schedule that changes, a
 * measured log, a note, a completed task, an archived task, a monthly
 * reflection, and a problem holding a Cloudinary reference.
 */
async function makeRecord(api) {
  const habit = await makeHabit({ name: "Run", unit: "km", start_date: "2026-01-05" });
  await makeSchedule(habit.id, {
    effective_from: "2026-02-02",
    schedule_kind: "weekly",
    weekly_target: 3,
    target_value: 5,
  });
  await makeSchedule(habit.id, { effective_from: "2026-03-02", schedule_kind: "paused" });
  await makeLog(habit.id, { date: "2026-01-05", status: "done", value: 4.5, note: "Cold." });
  await makeLog(habit.id, { date: "2026-01-06", status: "skipped" });
  await makeLog(habit.id, { date: "2026-01-07", status: "missed" });

  const retired = await makeHabit({ name: "Old", archived_at: "2026-02-01T09:00:00Z" });
  await makeLog(retired.id, { date: "2026-01-05", status: "done" });

  await makeTask({ title: "Open", due_date: "2026-01-09" });
  await makeTask({ title: "Done", completed: true, completed_at: "2026-01-08T10:00:00Z" });
  await makeTask({ title: "Filed", archived_at: "2026-01-08T10:00:00Z" });

  await makeJournal({ date: "2026-01-05", kind: "day", entry: "A day." });
  await makeJournal({ date: "2026-01-01", kind: "month", entry: "A month." });

  await makeProblem({
    number: 1,
    title: "Two Sum",
    topics: ["arrays", "hash map"],
    ai_assisted: true,
    approach: "A map of seen values.",
    screenshot_public_id: "habit-tracker/leetcode/abc123",
    screenshot_format: "png",
    screenshot_width: 800,
    screenshot_height: 600,
    screenshot_bytes: 12_345,
  });
  await makeProblem({ title: "Filed away", archived_at: "2026-02-01T09:00:00Z" });

  // Reminders, so the settings row in the document is not the row the migration
  // left behind: a restore that quietly reset preferences is a restore that
  // makes you set the app up again.
  await api("/api/reminders", {
    method: "PATCH",
    body: {
      notifications_enabled: true,
      task_reminders: false,
      quiet_start: "22:00",
      quiet_end: "07:00",
    },
  });
}

const exportDocument = async (api) => {
  const { status, body } = await json(await api("/api/export"));
  assert.equal(status, 200);
  return body;
};

describe("backup", () => {
  it("exports a versioned, timestamped document of every table", async () => {
    await withApi(async ({ api }) => {
      await makeRecord(api);
      const document = await exportDocument(api);

      assert.equal(document.version, 5);
      assert.match(document.exported_at, /^\d{4}-\d{2}-\d{2}T/);
      for (const table of [
        "habits",
        "habit_schedules",
        "habit_logs",
        "tasks",
        "journal",
        "leetcode_problems",
        "app_settings",
      ])
        assert.ok(Array.isArray(document[table]), `${table} is an array`);

      // The reference, never the bytes. The whole Cloudinary contract in one
      // assertion: a restored row points at the asset it always pointed at.
      const [solved] = document.leetcode_problems;
      assert.equal(solved.screenshot_public_id, "habit-tracker/leetcode/abc123");
      assert.ok(!("screenshot" in solved), "image bytes are not in the document");
    });
  });

  it("round-trips: export, wipe, import, and the document comes back identical", async () => {
    await withApi(async ({ api, client }) => {
      await makeRecord(api);
      const before = await exportDocument(api);

      // Everything gone, and something unrelated in its place — so a restore
      // that merely added rows back would be caught by the comparison.
      await client.query("TRUNCATE habits, tasks, journal, leetcode_problems CASCADE");
      await makeHabit({ name: "Wrong" });

      const { status, body } = await json(
        await api("/api/import", { method: "POST", body: before }),
      );
      assert.equal(status, 200);
      assert.equal(body.restored.habits, before.habits.length);
      assert.equal(body.restored.habit_logs, before.habit_logs.length);
      assert.equal(body.screenshots, 1);

      const after_ = await exportDocument(api);
      // exported_at is the moment of the second export and is meant to differ.
      assert.deepEqual({ ...after_, exported_at: null }, { ...before, exported_at: null });
    });
  });

  it("keeps ids, so a new habit after a restore does not collide with a restored one", async () => {
    await withApi(async ({ api, client }) => {
      await makeRecord(api);
      const before = await exportDocument(api);

      await api("/api/import", { method: "POST", body: before });

      const created = await json(
        await api("/api/habits", {
          method: "POST",
          body: {
            name: "After",
            color_token: "chart-2",
            start_date: "2026-04-01",
            schedule: { schedule_kind: "fixed", schedule_days: [1] },
          },
        }),
      );
      assert.equal(created.status, 201);

      const { rows } = await client.query("SELECT count(*)::int AS n FROM habits WHERE id = $1", [
        created.body.habit.id,
      ]);
      assert.equal(rows[0].n, 1);
      assert.ok(
        BigInt(created.body.habit.id) > BigInt(before.habits.at(-1).id),
        "the identity sequence was advanced past the restored ids",
      );
    });
  });

  it("reports what a file holds without writing anything", async () => {
    await withApi(async ({ api, client }) => {
      await makeRecord(api);
      const document = await exportDocument(api);

      const { status, body } = await json(
        await api("/api/import/check", { method: "POST", body: document }),
      );
      assert.equal(status, 200);
      assert.equal(body.version, 5);
      assert.equal(body.exported_at, document.exported_at);
      assert.equal(body.counts.habits, 2);
      assert.equal(body.counts.leetcode_problems, 2);
      assert.equal(body.screenshots, 1);
      assert.ok(!("parsed" in body), "the summary does not echo the whole file back");

      // The check is a read. The habit that was there before it is still there.
      const { rows } = await client.query("SELECT count(*)::int AS n FROM habits");
      assert.equal(rows[0].n, 2);
    });
  });

  describe("refuses", () => {
    const rejects = (body, pattern) =>
      withApi(async ({ api, client }) => {
        const habit = await makeHabit({ name: "Untouched" });

        const result = await json(await api("/api/import", { method: "POST", body }));
        assert.equal(result.status, 400);
        if (pattern) assert.match(JSON.stringify(result.body), pattern);

        // The whole point: a refused import changed nothing.
        const { rows } = await client.query("SELECT name FROM habits");
        assert.deepEqual(rows, [{ name: habit.name }]);
      });

    it("a file that is not a backup", () => rejects({ hello: "world" }, /version/i));
    it("a backup from another version", () =>
      rejects({ version: 99, exported_at: "2026-01-01T00:00:00Z" }, /version 99/));
    it("a missing table", async () => {
      await withApi(async ({ api }) => {
        const document = await exportDocument(api);
        delete document.habit_logs;
        const { status } = await json(await api("/api/import", { method: "POST", body: document }));
        assert.equal(status, 400);
      });
    });
    it("a row missing a required field", () =>
      withApi(async ({ api, client }) => {
        await makeHabit();
        const document = await exportDocument(api);
        delete document.habits[0].start_date;

        const { status } = await json(await api("/api/import", { method: "POST", body: document }));
        assert.equal(status, 400);
        const { rows } = await client.query("SELECT count(*)::int AS n FROM habits");
        assert.equal(rows[0].n, 1);
      }));
    /*
     * A row that is shape-valid and domain-invalid: only the CHECK constraint
     * knows. Under the rollback harness the restore's withTransaction JOINS the
     * test's transaction rather than opening its own (see CLAUDE.md), so the
     * failed statement aborts that one transaction and nothing can be read back
     * afterwards — which is exactly the atomicity being relied on, and also why
     * it cannot be observed from in here. The refusal is what is asserted; the
     * rollback is withTransaction's, and the cases above cover "wrote nothing"
     * for the corruption that actually happens to a file.
     */
    it("a row the database itself will not have", () =>
      withApi(async ({ api }) => {
        await makeHabit();
        const document = await exportDocument(api);
        document.habits[0].color_token = "chart-9";

        const { status, body } = await json(
          await api("/api/import", { method: "POST", body: document }),
        );
        assert.equal(status, 400);
        assert.match(body.error, /rejected/i);
      }));
    it("a log pointing at a habit the file does not contain", () =>
      withApi(async ({ api }) => {
        const habit = await makeHabit();
        await makeLog(habit.id, { date: "2026-01-05" });
        const document = await exportDocument(api);
        document.habits = [];
        document.habit_schedules = [];

        const { status } = await json(await api("/api/import", { method: "POST", body: document }));
        assert.equal(status, 400);
      }));
  });

  it("leaves a settings row behind even when the file carries none", async () => {
    await withApi(async ({ api, client }) => {
      const document = await exportDocument(api);
      document.app_settings = [];

      const { status } = await json(await api("/api/import", { method: "POST", body: document }));
      assert.equal(status, 200);

      const { rows } = await client.query("SELECT id FROM app_settings");
      assert.deepEqual(rows, [{ id: 1 }]);
    });
  });

  it("needs a session", async () => {
    await withApi(async ({ request }) => {
      const check = await request("/api/import/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(check.status, 401);

      const restore = await request("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(restore.status, 401);
    });
  });
});
