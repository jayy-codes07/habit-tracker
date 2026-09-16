/**
 * GET /api/compare/:month — the same month, a year apart.
 *
 * The rule the whole endpoint rests on is that it reports counts and nothing
 * derived from them: no difference, no direction, no rate. A test that only
 * checked the figures would let a "change" field be added tomorrow, so the
 * shape is asserted as well as the arithmetic.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { withApi } from "./helpers/api.js";
import { closePool, makeHabit, makeJournal, makeLog, makeProblem, makeTask } from "./helpers/db.js";

after(closePool);

const compare = async (api, month) => {
  const response = await api(`/api/compare/${month}`);
  assert.equal(response.status, 200);
  return response.json();
};

/** March, and the March before it. */
const NOW = "2026-03";
const THEN = "2025-03";

describe("what it compares", () => {
  it("reads the same month a year earlier", async () => {
    await withApi(async ({ api }) => {
      const body = await compare(api, NOW);
      assert.equal(body.month, NOW);
      assert.equal(body.current.month, NOW);
      assert.equal(body.previous.month, THEN);
    });
  });

  it("counts written days and whether the month was reflected on", async () => {
    await withApi(async ({ api }) => {
      await makeJournal({ date: "2026-03-04", entry: "One." });
      await makeJournal({ date: "2026-03-05", entry: "Two." });
      await makeJournal({ date: "2026-03-01", kind: "month", entry: "A month." });
      await makeJournal({ date: "2025-03-09", entry: "A year ago." });

      const { current, previous } = await compare(api, NOW);
      assert.equal(current.journal_days, 2);
      assert.equal(current.reflection, true);
      assert.equal(previous.journal_days, 1);
      assert.equal(previous.reflection, false);
    });
  });

  it("counts logged days by status, and the habits that were alive", async () => {
    await withApi(async ({ api }) => {
      const habit = await makeHabit({ name: "Run", start_date: "2025-01-01" });
      await makeLog(habit.id, { date: "2026-03-02", status: "done" });
      await makeLog(habit.id, { date: "2026-03-03", status: "missed" });
      await makeLog(habit.id, { date: "2026-03-04", status: "skipped" });
      await makeLog(habit.id, { date: "2026-03-05", status: "done" });
      // Outside the month, and must not be counted in it.
      await makeLog(habit.id, { date: "2026-04-01", status: "done" });

      const { current, previous } = await compare(api, NOW);
      assert.deepEqual(current.habit_days, { done: 2, missed: 1, skipped: 1 });
      assert.equal(current.habits, 1);
      assert.deepEqual(previous.habit_days, { done: 0, missed: 0, skipped: 0 });
      // It existed a year ago too — it just had nothing logged.
      assert.equal(previous.habits, 1);
    });
  });

  it("does not count a habit that did not exist yet", async () => {
    await withApi(async ({ api }) => {
      await makeHabit({ start_date: "2026-02-01" });
      const { current, previous } = await compare(api, NOW);
      assert.equal(current.habits, 1);
      assert.equal(previous.habits, 0);
    });
  });

  it("counts tasks completed and created, in the app's own zone", async () => {
    await withApi(async ({ api }) => {
      await makeTask({
        completed: true,
        completed_at: "2026-03-10T09:00:00Z",
      });
      const { current } = await compare(api, NOW);
      assert.equal(current.tasks.completed, 1);
    });
  });

  it("counts solves, archived ones included", async () => {
    await withApi(async ({ api }) => {
      await makeProblem({ solved_on: "2026-03-11" });
      await makeProblem({ solved_on: "2026-03-12", archived_at: "2026-04-01T00:00:00Z" });
      await makeProblem({ solved_on: "2025-03-11" });

      const { current, previous } = await compare(api, NOW);
      // Archiving tidies the working list; the solve still happened that month.
      assert.equal(current.leetcode, 2);
      assert.equal(previous.leetcode, 1);
    });
  });
});

describe("how it answers", () => {
  /*
   * The distinction the screen is built on: a year with no record is not a year
   * that went badly, and a column of zeroes reads as the second.
   */
  it("says whether a month has any record at all", async () => {
    await withApi(async ({ api }) => {
      const empty = await compare(api, NOW);
      assert.equal(empty.current.present, false);
      assert.equal(empty.previous.present, false);

      await makeJournal({ date: "2025-03-02", entry: "Something happened." });

      const some = await compare(api, NOW);
      assert.equal(some.current.present, false);
      assert.equal(some.previous.present, true);
    });
  });

  /*
   * The product states what happened; it does not grade it. Nothing here may
   * report a difference, a direction or a rate — see buildCompare.
   */
  it("reports counts only, and never a difference between them", async () => {
    await withApi(async ({ api }) => {
      const body = await compare(api, NOW);

      assert.deepEqual(Object.keys(body).sort(), ["current", "month", "previous"]);
      assert.deepEqual(Object.keys(body.current).sort(), [
        "habit_days",
        "habits",
        "journal_days",
        "leetcode",
        "month",
        "present",
        "reflection",
        "tasks",
      ]);
    });
  });

  it("crosses a year boundary correctly", async () => {
    await withApi(async ({ api }) => {
      const body = await compare(api, "2026-01");
      assert.equal(body.previous.month, "2025-01");
    });
  });

  it("rejects anything that is not a month", async () => {
    await withApi(async ({ api }) => {
      for (const month of ["2026-13", "2026-1", "2026-03-01", "nope"]) {
        assert.equal((await api(`/api/compare/${month}`)).status, 400, month);
      }
    });
  });

  it("needs a session", async () => {
    await withApi(async ({ request }) => {
      assert.equal((await request(`/api/compare/${NOW}`)).status, 401);
    });
  });
});
