/**
 * The boundary between stored schedule versions and the resolver that reads them.
 *
 * The resolution *rule* is a pure function now and is covered exhaustively, with
 * no database, in scheduling.test.js. What is left here is the part that can
 * only be checked against a real Postgres: that the rows come back in the shape
 * resolveSchedule assumes.
 *
 * That shape is load-bearing and easy to break silently:
 *   * effective_from must arrive as a 'YYYY-MM-DD' string, not a Date — the
 *     resolver compares dates with <=, and a Date object would compare by
 *     reference coercion and quietly resolve the wrong version.
 *   * versions must arrive ascending, because the resolver walks forward and
 *     keeps the last one that has started.
 *   * schedule_days must arrive as an array of numbers to match isoWeekday().
 *
 * Until Step 3.5 this file tested a scheduleOn() helper that lived only in the
 * test harness, so it verified an implementation production never called. The
 * resolver now lives in src/lib/scheduling.js and this asserts the contract it
 * depends on.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { query } from "../src/db/index.js";
import { isIsoDate } from "../src/lib/dates.js";
import { resolveSchedule } from "../src/lib/scheduling.js";
import { closePool, makeHabit, makeSchedule, withRollback } from "./helpers/db.js";

after(closePool);

const START = "2026-01-05"; // a Monday
const CHANGED = "2026-02-02"; // four weeks later, also a Monday

/** The query the habits service uses to load a habit's schedule history. */
function loadVersions(habitId) {
  return query(
    `SELECT effective_from, schedule_kind, schedule_days, weekly_target
       FROM habit_schedules
      WHERE habit_id = $1
      ORDER BY effective_from`,
    [habitId],
  ).then(({ rows }) => rows);
}

describe("stored schedule versions", () => {
  it("come back in the shape the resolver expects", async () => {
    await withRollback(async () => {
      const habit = await makeHabit({ start_date: START, schedule: false });
      await makeSchedule(habit.id, { effective_from: START, schedule_days: [1, 3, 5] });

      const [version] = await loadVersions(habit.id);

      assert.equal(typeof version.effective_from, "string", "effective_from must not be a Date");
      assert.equal(isIsoDate(version.effective_from), true);
      assert.equal(version.effective_from, START);
      assert.equal(version.schedule_kind, "fixed");
      assert.deepEqual(version.schedule_days, [1, 3, 5]);
      assert.equal(version.weekly_target, null);
      // The resolver compares weekdays as numbers.
      assert.equal(typeof version.schedule_days[0], "number");
    });
  });

  it("are ordered oldest first, whatever order they were written in", async () => {
    await withRollback(async () => {
      const habit = await makeHabit({ start_date: START, schedule: false });
      // Deliberately inserted out of order.
      await makeSchedule(habit.id, { effective_from: CHANGED, schedule_days: [2, 4] });
      await makeSchedule(habit.id, { effective_from: START, schedule_days: [1, 3, 5] });

      const versions = await loadVersions(habit.id);
      assert.deepEqual(
        versions.map((version) => version.effective_from),
        [START, CHANGED],
      );
    });
  });

  it("resolve end to end, from stored rows to a verdict-ready version", async () => {
    await withRollback(async () => {
      const habit = await makeHabit({ start_date: START, schedule: false });
      await makeSchedule(habit.id, { effective_from: START, schedule_days: [1, 3, 5] });
      await makeSchedule(habit.id, { effective_from: CHANGED, schedule_kind: "paused" });

      const versions = await loadVersions(habit.id);

      assert.equal(resolveSchedule(versions, START, "2026-01-04"), null, "before the start");
      assert.deepEqual(resolveSchedule(versions, START, START).schedule_days, [1, 3, 5]);
      assert.deepEqual(resolveSchedule(versions, START, "2026-02-01").schedule_days, [1, 3, 5]);
      assert.equal(resolveSchedule(versions, START, CHANGED).schedule_kind, "paused");
    });
  });

  it("keeps a weekly target as a number", async () => {
    await withRollback(async () => {
      const habit = await makeHabit({ start_date: START, schedule: false });
      await makeSchedule(habit.id, {
        effective_from: START,
        schedule_kind: "weekly",
        weekly_target: 3,
      });

      const [version] = await loadVersions(habit.id);
      assert.equal(version.weekly_target, 3);
      assert.equal(typeof version.weekly_target, "number", "smallint must not arrive as a string");
      assert.equal(version.schedule_days, null);
    });
  });
});
