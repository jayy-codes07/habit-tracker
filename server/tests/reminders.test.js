/**
 * Reminders: the settings row, who is eligible, and saying a thing once.
 *
 * Most of this is eligibility, which is the whole product risk here — a
 * reminder about a paused habit, an archived one, a finished task or an empty
 * review queue is not a small bug, it is the feature becoming noise. So every
 * exclusion has a case, and each one differs from the eligible fixture beside
 * it by exactly the fact under test.
 *
 * Quiet hours are tested twice over: the arithmetic as a pure function, where
 * the overnight case can be enumerated without a clock, and once through the
 * endpoint against a window built around the current minute — which is the only
 * honest way to assert it end to end without a clock the app is forbidden from
 * mocking.
 *
 *   docker compose exec api node --test --import ./tests/helpers/env.js tests/reminders.test.js
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { query } from "../src/db/index.js";
import { addDays, nowTime, startOfWeek, today } from "../src/lib/dates.js";
import { dueNow, inQuietHours } from "../src/modules/reminders/reminders.service.js";
import { withApi, json } from "./helpers/api.js";
import {
  closePool,
  makeHabit,
  makeLog,
  makeProblem,
  makeSchedule,
  makeTask,
} from "./helpers/db.js";

after(closePool);

/** Always in the past, whatever the wall clock says when the suite runs. */
const PASSED = "00:00";

/** Turns everything on, so a test only has to say what it is about. */
const enable = (api, extra = {}) =>
  api("/api/reminders", { method: "PATCH", body: { notifications_enabled: true, ...extra } });

/**
 * What the scheduler would push, claimed exactly as it claims it.
 *
 * Called directly rather than over HTTP: there is no "what is due" endpoint any
 * more, because delivery is a Web Push from the server rather than a page
 * asking. The rules under test did not change with it — this is still the one
 * function that decides them.
 */
const due = async () => dueNow();

const keys = (reminders) => reminders.map((reminder) => reminder.key);

/** A habit that today actually asks something of, reminded at a time gone by. */
async function remindedHabit(overrides = {}) {
  const habit = await makeHabit(overrides);
  await query("UPDATE habits SET reminder_at = $2 WHERE id = $1", [habit.id, PASSED]);
  return habit;
}

// ---------------------------------------------------------------------------

describe("reminder settings", () => {
  it("starts with notifications off and nothing configured", () =>
    withApi(async ({ api }) => {
      const { status, body } = await json(await api("/api/reminders"));
      assert.equal(status, 200);
      assert.deepEqual(body.settings, {
        notifications_enabled: false,
        habit_reminders: true,
        task_reminders: true,
        leetcode_reminder_at: null,
        quiet_start: null,
        quiet_end: null,
      });
    }));

  it("patches one field and leaves the rest alone", () =>
    withApi(async ({ api }) => {
      const { body } = await json(await enable(api, { habit_reminders: false }));
      assert.equal(body.settings.notifications_enabled, true);
      assert.equal(body.settings.habit_reminders, false);
      assert.equal(body.settings.task_reminders, true);
    }));

  it("turns the LeetCode reminder on with a time and off with null", () =>
    withApi(async ({ api }) => {
      const on = await json(await enable(api, { leetcode_reminder_at: "20:30" }));
      assert.equal(on.body.settings.leetcode_reminder_at, "20:30");

      const off = await json(
        await api("/api/reminders", { method: "PATCH", body: { leetcode_reminder_at: null } }),
      );
      assert.equal(off.body.settings.leetcode_reminder_at, null);
    }));

  it("refuses half a quiet window", () =>
    withApi(async ({ api }) => {
      const { status } = await json(
        await api("/api/reminders", { method: "PATCH", body: { quiet_start: "22:00" } }),
      );
      assert.equal(status, 400);
    }));

  it("refuses a quiet window with no length", () =>
    withApi(async ({ api }) => {
      const { status } = await json(
        await api("/api/reminders", {
          method: "PATCH",
          body: { quiet_start: "22:00", quiet_end: "22:00" },
        }),
      );
      assert.equal(status, 400);
    }));

  it("refuses a time that is not HH:MM", () =>
    withApi(async ({ api }) => {
      for (const value of ["8:00", "20:00:00", "25:00", "20:60", "evening"]) {
        const { status } = await json(
          await api("/api/reminders", { method: "PATCH", body: { leetcode_reminder_at: value } }),
        );
        assert.equal(status, 400, `expected 400 for ${value}`);
      }
    }));
});

// ---------------------------------------------------------------------------

describe("quiet hours", () => {
  it("covers a window inside one day", () => {
    assert.equal(inQuietHours("13:00", "12:00", "14:00"), true);
    assert.equal(inQuietHours("12:00", "12:00", "14:00"), true, "the start is inside");
    assert.equal(inQuietHours("14:00", "12:00", "14:00"), false, "the end is not");
    assert.equal(inQuietHours("11:59", "12:00", "14:00"), false);
  });

  it("covers a window that runs past midnight", () => {
    assert.equal(inQuietHours("23:00", "22:30", "07:30"), true);
    assert.equal(inQuietHours("03:00", "22:30", "07:30"), true);
    assert.equal(inQuietHours("07:29", "22:30", "07:30"), true);
    assert.equal(inQuietHours("07:30", "22:30", "07:30"), false);
    assert.equal(inQuietHours("12:00", "22:30", "07:30"), false);
    assert.equal(inQuietHours("22:29", "22:30", "07:30"), false);
  });

  it("is never quiet with no window, or with one of no length", () => {
    assert.equal(inQuietHours("13:00", null, null), false);
    assert.equal(inQuietHours("13:00", "12:00", null), false);
    assert.equal(inQuietHours("13:00", "22:00", "22:00"), false);
  });

  it("suppresses a reminder that would otherwise be due", () =>
    withApi(async ({ api }) => {
      await remindedHabit();

      // A window around the current minute, wrapping over midnight when it has
      // to. Built from nowTime() rather than a fixed pair because the app reads
      // its own clock and must not be given a fake one.
      const shift = (minutes) => {
        const [hour, minute] = nowTime().split(":").map(Number);
        const total = (hour * 60 + minute + minutes + 1440) % 1440;
        return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
      };

      await enable(api, { quiet_start: shift(-60), quiet_end: shift(60) });
      assert.deepEqual(await due(), []);
    }));
});

// ---------------------------------------------------------------------------

describe("what is due", () => {
  it("says nothing at all while notifications are off", () =>
    withApi(async () => {
      await remindedHabit();
      assert.deepEqual(await due(), []);
    }));

  it("reminds about a habit today asks something of", () =>
    withApi(async ({ api }) => {
      const habit = await remindedHabit({ name: "Morning run" });
      await enable(api);

      const reminders = await due();
      assert.deepEqual(keys(reminders), [`habit:${habit.id}`]);
      // Neutral wording, and a statement of fact. Nothing about a streak.
      assert.equal(reminders[0].title, "Morning run");
      assert.equal(reminders[0].body, "Scheduled for today.");
    }));

  it("says nothing about a habit with no reminder time", () =>
    withApi(async ({ api }) => {
      await makeHabit();
      await enable(api);
      assert.deepEqual(await due(), []);
    }));

  it("says nothing about a habit whose time has not come", () =>
    withApi(async ({ api }) => {
      const habit = await makeHabit();
      await query("UPDATE habits SET reminder_at = '23:59' WHERE id = $1", [habit.id]);
      await enable(api);
      // 23:59 is only "passed" in the last minute of the day, which is the one
      // minute this assertion cannot make. Skipping it there keeps the suite
      // honest rather than green by luck.
      if (nowTime() < "23:59") assert.deepEqual(await due(), []);
    }));

  it("says nothing about a paused habit", () =>
    withApi(async ({ api }) => {
      const habit = await remindedHabit();
      await makeSchedule(habit.id, {
        effective_from: addDays(today(), -1),
        schedule_kind: "paused",
      });
      await enable(api);
      assert.deepEqual(await due(), []);
    }));

  it("says nothing about an archived habit", () =>
    withApi(async ({ api }) => {
      await remindedHabit({ archived_at: new Date().toISOString() });
      await enable(api);
      assert.deepEqual(await due(), []);
    }));

  it("says nothing on a day the habit is not scheduled for", () =>
    withApi(async ({ api }) => {
      const habit = await remindedHabit({ schedule: false });
      // Every weekday except this one.
      const weekday = new Date(`${today()}T12:00:00Z`).getUTCDay() || 7;
      await makeSchedule(habit.id, {
        effective_from: addDays(today(), -7),
        schedule_days: [1, 2, 3, 4, 5, 6, 7].filter((day) => day !== weekday),
      });
      await enable(api);
      assert.deepEqual(await due(), []);
    }));

  it("reminds about a weekly habit on any day its week is still open", () =>
    withApi(async ({ api }) => {
      const habit = await remindedHabit({ schedule: false });
      await makeSchedule(habit.id, {
        effective_from: addDays(today(), -7),
        schedule_kind: "weekly",
      });
      await enable(api);
      assert.deepEqual(keys(await due()), [`habit:${habit.id}`]);
    }));

  /**
   * A day of the current week that is not today, whichever weekday the suite
   * runs on. The two cases below need a done day the "already decided today"
   * filter cannot account for, or they would pass for the wrong reason.
   */
  const otherDayThisWeek = () => {
    const monday = startOfWeek(today());
    return [0, 1, 2, 3, 4, 5, 6]
      .map((offset) => addDays(monday, offset))
      .find((date) => date !== today());
  };

  /** A weekly habit reminded at a time gone by, with one done day this week. */
  async function weeklyHabitWithOneDone(target) {
    const habit = await remindedHabit({ schedule: false });
    await makeSchedule(habit.id, {
      effective_from: addDays(today(), -14),
      schedule_kind: "weekly",
      weekly_target: target,
    });
    await makeLog(habit.id, { date: otherDayThisWeek(), status: "done" });
    return habit;
  }

  it("says nothing about a weekly habit whose week is already met", () =>
    withApi(async ({ api }) => {
      await weeklyHabitWithOneDone(1);
      await enable(api);
      assert.deepEqual(await due(), []);
    }));

  it("still reminds about a weekly habit whose week is short of target", () =>
    withApi(async ({ api }) => {
      const habit = await weeklyHabitWithOneDone(2);
      await enable(api);
      assert.deepEqual(keys(await due()), [`habit:${habit.id}`]);
    }));

  it("says nothing about a habit the day has already been decided for", () =>
    withApi(async ({ api }) => {
      const habit = await remindedHabit();
      await makeLog(habit.id, { date: today(), status: "skipped" });
      await enable(api);
      assert.deepEqual(await due(), []);
    }));

  it("respects a schedule version dated in the future", () =>
    withApi(async ({ api }) => {
      const habit = await remindedHabit();
      // Tomorrow it pauses; today it is still being asked for.
      await makeSchedule(habit.id, {
        effective_from: addDays(today(), 1),
        schedule_kind: "paused",
      });
      await enable(api);
      assert.deepEqual(keys(await due()), [`habit:${habit.id}`]);
    }));

  it("says nothing about any habit when habit reminders are off", () =>
    withApi(async ({ api }) => {
      await remindedHabit();
      await enable(api, { habit_reminders: false });
      assert.deepEqual(await due(), []);
    }));
});

// ---------------------------------------------------------------------------

describe("task reminders", () => {
  const remindedTask = async (overrides = {}) => {
    const task = await makeTask({ due_date: today(), ...overrides });
    await query("UPDATE tasks SET reminder_at = $2 WHERE id = $1", [task.id, PASSED]);
    return task;
  };

  it("reminds about a dated, open task", () =>
    withApi(async ({ api }) => {
      const task = await remindedTask({ title: "Renew the passport" });
      await enable(api);

      const reminders = await due();
      assert.deepEqual(keys(reminders), [`task:${task.id}`]);
      assert.equal(reminders[0].title, "Renew the passport");
      assert.equal(reminders[0].body, "Due today.");
    }));

  it("says nothing about a completed task", () =>
    withApi(async ({ api }) => {
      await remindedTask({ completed: true, completed_at: new Date().toISOString() });
      await enable(api);
      assert.deepEqual(await due(), []);
    }));

  it("says nothing about an archived task", () =>
    withApi(async ({ api }) => {
      await remindedTask({ archived_at: new Date().toISOString() });
      await enable(api);
      assert.deepEqual(await due(), []);
    }));

  it("says nothing about a task due on another day", () =>
    withApi(async ({ api }) => {
      await remindedTask({ due_date: addDays(today(), -1) });
      await enable(api);
      assert.deepEqual(await due(), [], "an overdue task is not reminded about again");

      await remindedTask({ due_date: addDays(today(), 1) });
      assert.deepEqual(await due(), []);
    }));

  it("refuses to store a reminder on an undated task", () =>
    withApi(async ({ api }) => {
      const { body } = await json(
        await api("/api/tasks", {
          method: "POST",
          body: { title: "Someday", due_date: null, reminder_at: "09:00" },
        }),
      );
      assert.equal(body.task.reminder_at, null);
    }));

  it("clears the reminder when the due date is cleared", () =>
    withApi(async ({ api }) => {
      const created = await json(
        await api("/api/tasks", {
          method: "POST",
          body: { title: "Dentist", due_date: today(), reminder_at: "09:00" },
        }),
      );
      assert.equal(created.body.task.reminder_at, "09:00");

      const cleared = await json(
        await api(`/api/tasks/${created.body.task.id}`, {
          method: "PATCH",
          body: { due_date: null },
        }),
      );
      assert.equal(cleared.body.task.due_date, null);
      assert.equal(cleared.body.task.reminder_at, null);
    }));

  it("says nothing about any task when task reminders are off", () =>
    withApi(async ({ api }) => {
      await remindedTask();
      await enable(api, { task_reminders: false });
      assert.deepEqual(await due(), []);
    }));
});

// ---------------------------------------------------------------------------

describe("the LeetCode review reminder", () => {
  it("reminds once for the whole queue, and counts it", () =>
    withApi(async ({ api }) => {
      await makeProblem({ ai_assisted: true });
      await makeProblem({ ai_assisted: true });
      await enable(api, { leetcode_reminder_at: PASSED });

      const reminders = await due();
      assert.deepEqual(keys(reminders), ["leetcode"]);
      assert.equal(reminders[0].body, "2 problems are waiting for review.");
    }));

  it("says nothing when nothing is waiting", () =>
    withApi(async ({ api }) => {
      // Reviewed, unassisted and archived: the three ways out of the queue.
      await makeProblem({ ai_assisted: true, reviewed_on: today() });
      await makeProblem({ ai_assisted: false });
      await makeProblem({ ai_assisted: true, archived_at: new Date().toISOString() });
      await enable(api, { leetcode_reminder_at: PASSED });
      assert.deepEqual(await due(), []);
    }));

  it("says nothing while the reminder is off, however long the queue", () =>
    withApi(async ({ api }) => {
      await makeProblem({ ai_assisted: true });
      await enable(api);
      assert.deepEqual(await due(), []);
    }));
});

// ---------------------------------------------------------------------------

describe("saying it once", () => {
  it("does not repeat a reminder already delivered today", () =>
    withApi(async ({ api }) => {
      const habit = await remindedHabit();
      await makeProblem({ ai_assisted: true });
      await enable(api, { leetcode_reminder_at: PASSED });

      assert.deepEqual(keys(await due()).sort(), [`habit:${habit.id}`, "leetcode"].sort());
      // A refresh, a second tab, a reopened app: the same question, asked again.
      assert.deepEqual(await due(), []);
      assert.deepEqual(await due(), []);
    }));

  it("keys a delivery to its day, so tomorrow is a new one", () =>
    withApi(async ({ api }) => {
      const habit = await remindedHabit();
      await enable(api);
      await due();

      // What yesterday's delivery looks like the morning after.
      await query("UPDATE reminder_deliveries SET on_date = $1", [addDays(today(), -1)]);
      assert.deepEqual(keys(await due()), [`habit:${habit.id}`]);
    }));

  it("sweeps deliveries older than a week", () =>
    withApi(async ({ api }) => {
      await remindedHabit();
      await enable(api);
      await query("INSERT INTO reminder_deliveries (key, on_date) VALUES ($1, $2)", [
        "habit:stale",
        addDays(today(), -30),
      ]);

      await due();
      const { rows } = await query("SELECT count(*)::int AS count FROM reminder_deliveries");
      assert.equal(rows[0].count, 1, "only today's delivery is left");
    }));
});
