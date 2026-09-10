/**
 * Resolving a habit's schedule for a given day.
 *
 * This is the rule the whole consistency grid rests on: the version in force on
 * date D is the latest one that has started, and nothing resolves before the
 * habit's own start_date. Getting it wrong does not throw — it silently
 * re-scores history, which is exactly the failure the versioned schedule was
 * introduced to prevent.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { closePool, makeHabit, makeSchedule, scheduleOn, withRollback } from "./helpers/db.js";

after(closePool);

const START = "2026-01-05"; // a Monday
const CHANGED = "2026-02-02"; // four weeks later, also a Monday

/** Mirrors the seed's 'run': Mon/Wed/Fri, later moved to Tue/Thu. */
async function habitWithScheduleChange() {
  const habit = await makeHabit({ start_date: START, schedule: false });
  await makeSchedule(habit.id, { effective_from: START, schedule_days: [1, 3, 5] });
  await makeSchedule(habit.id, { effective_from: CHANGED, schedule_days: [2, 4] });
  return habit;
}

describe("schedule resolution", () => {
  it("resolves nothing before the habit started", async () => {
    await withRollback(async () => {
      const habit = await habitWithScheduleChange();
      assert.equal(await scheduleOn(habit.id, "2026-01-04"), null);
      assert.equal(await scheduleOn(habit.id, "2025-12-31"), null);
    });
  });

  it("resolves the first version on the start date itself", async () => {
    await withRollback(async () => {
      const habit = await habitWithScheduleChange();
      const schedule = await scheduleOn(habit.id, START);
      assert.deepEqual(schedule.schedule_days, [1, 3, 5]);
    });
  });

  it("keeps the old version for every day before the change", async () => {
    await withRollback(async () => {
      const habit = await habitWithScheduleChange();
      for (const date of ["2026-01-05", "2026-01-20", "2026-02-01"]) {
        const schedule = await scheduleOn(habit.id, date);
        assert.deepEqual(schedule.schedule_days, [1, 3, 5], `wrong version on ${date}`);
      }
    });
  });

  it("switches on the day the new version takes effect, not before", async () => {
    await withRollback(async () => {
      const habit = await habitWithScheduleChange();

      const dayBefore = await scheduleOn(habit.id, "2026-02-01");
      assert.deepEqual(dayBefore.schedule_days, [1, 3, 5]);

      const onTheDay = await scheduleOn(habit.id, CHANGED);
      assert.deepEqual(onTheDay.schedule_days, [2, 4]);
    });
  });

  it("keeps the latest version indefinitely", async () => {
    await withRollback(async () => {
      const habit = await habitWithScheduleChange();
      const schedule = await scheduleOn(habit.id, "2027-06-30");
      assert.deepEqual(schedule.schedule_days, [2, 4]);
    });
  });
});

describe("paused spans", () => {
  /** Mirrors the seed's 'read': daily, paused for a week, then daily again. */
  async function pausedHabit() {
    const habit = await makeHabit({ start_date: START, schedule: false });
    await makeSchedule(habit.id, { effective_from: START });
    await makeSchedule(habit.id, { effective_from: "2026-02-02", schedule_kind: "paused" });
    await makeSchedule(habit.id, { effective_from: "2026-02-09" });
    return habit;
  }

  it("resolves as paused for every day of the pause", async () => {
    await withRollback(async () => {
      const habit = await pausedHabit();
      for (const date of ["2026-02-02", "2026-02-05", "2026-02-08"]) {
        const schedule = await scheduleOn(habit.id, date);
        assert.equal(schedule.schedule_kind, "paused", `not paused on ${date}`);
        assert.equal(schedule.schedule_days, null);
        assert.equal(schedule.weekly_target, null);
      }
    });
  });

  it("is scheduled again the day the pause ends", async () => {
    await withRollback(async () => {
      const habit = await pausedHabit();

      const lastPausedDay = await scheduleOn(habit.id, "2026-02-08");
      assert.equal(lastPausedDay.schedule_kind, "paused");

      const resumed = await scheduleOn(habit.id, "2026-02-09");
      assert.equal(resumed.schedule_kind, "fixed");
      assert.deepEqual(resumed.schedule_days, [1, 2, 3, 4, 5, 6, 7]);
    });
  });

  it("still resolves normally before the pause began", async () => {
    await withRollback(async () => {
      const habit = await pausedHabit();
      const schedule = await scheduleOn(habit.id, "2026-02-01");
      assert.equal(schedule.schedule_kind, "fixed");
    });
  });
});

describe("weekly targets", () => {
  it("carries the target of the version in force", async () => {
    await withRollback(async () => {
      const habit = await makeHabit({ start_date: START, schedule: false });
      await makeSchedule(habit.id, {
        effective_from: START,
        schedule_kind: "weekly",
        weekly_target: 3,
      });
      await makeSchedule(habit.id, {
        effective_from: CHANGED,
        schedule_kind: "weekly",
        weekly_target: 5,
      });

      assert.equal((await scheduleOn(habit.id, "2026-01-20")).weekly_target, 3);
      assert.equal((await scheduleOn(habit.id, CHANGED)).weekly_target, 5);
    });
  });

  it("can switch a habit between fixed and weekly over time", async () => {
    await withRollback(async () => {
      const habit = await makeHabit({ start_date: START, schedule: false });
      await makeSchedule(habit.id, { effective_from: START, schedule_days: [1, 3, 5] });
      await makeSchedule(habit.id, {
        effective_from: CHANGED,
        schedule_kind: "weekly",
        weekly_target: 4,
      });

      const before = await scheduleOn(habit.id, "2026-01-19");
      assert.equal(before.schedule_kind, "fixed");
      assert.equal(before.weekly_target, null);

      const later = await scheduleOn(habit.id, "2026-02-16");
      assert.equal(later.schedule_kind, "weekly");
      assert.equal(later.schedule_days, null);
      assert.equal(later.weekly_target, 4);
    });
  });
});
