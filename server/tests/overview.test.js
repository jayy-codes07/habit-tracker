/**
 * The aggregate read endpoints: /api/day, /api/grid, /api/review, /api/export.
 *
 * These are the contracts the SPA will be written against, so the shapes matter
 * as much as the numbers: the grid's week alignment, the day screen's four log
 * states, and an export that leaves nothing behind.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { addDays, eachDay, endOfWeek, isoWeekday, startOfWeek, today } from "../src/lib/dates.js";
import { withApi } from "./helpers/api.js";
import {
  closePool,
  makeHabit,
  makeLog,
  makeProblem,
  makeSchedule,
  makeTask,
} from "./helpers/db.js";

after(closePool);

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

const getJson = async (api, path) => {
  const response = await api(path);
  assert.equal(response.status, 200, `${path} returned ${response.status}`);
  return response.json();
};

// ---------------------------------------------------------------------------
// The day screen
// ---------------------------------------------------------------------------

describe("GET /api/day/:date", () => {
  it("answers the whole screen in one request", async () => {
    await withApi(async ({ api }) => {
      const date = today();
      const habit = await makeHabit({ name: "Read", start_date: addDays(date, -10) });
      await makeLog(habit.id, { date, status: "done", note: "Chapter 8." });
      await makeTask({ title: "Call Mum", due_date: date });
      await api(`/api/journal/day/${date}`, { method: "PUT", body: { entry: "A good day." } });

      const body = await getJson(api, `/api/day/${date}`);

      assert.equal(body.date, date);
      assert.equal(body.today, date, "the client should not need its own clock");
      assert.equal(body.habits.length, 1);
      assert.equal(body.habits[0].status, "done");
      assert.equal(body.habits[0].note, "Chapter 8.");
      assert.equal(body.tasks.due.length, 1);
      assert.equal(body.journal.entry, "A good day.");
    });
  });

  /** All four states have to survive into the response, not just three. */
  it("distinguishes never-logged from the three logged statuses", async () => {
    await withApi(async ({ api }) => {
      const date = addDays(today(), -1);
      const start = addDays(date, -5);

      const habits = {};
      for (const status of ["done", "missed", "skipped"]) {
        const habit = await makeHabit({ name: status, start_date: start });
        await makeLog(habit.id, { date, status });
        habits[status] = habit.id;
      }
      await makeHabit({ name: "never", start_date: start });

      const body = await getJson(api, `/api/day/${date}`);
      const byName = Object.fromEntries(body.habits.map((h) => [h.name, h]));

      assert.equal(byName.done.status, "done");
      assert.equal(byName.missed.status, "missed");
      assert.equal(byName.skipped.status, "skipped");
      assert.equal(byName.never.status, null, "no row means never logged");
      assert.equal(byName.never.verdict, "unlogged");
    });
  });

  it("reports a streak that an unlogged today has not broken", async () => {
    await withApi(async ({ api }) => {
      const date = today();
      const habit = await makeHabit({ start_date: addDays(date, -5) });
      for (let back = 1; back <= 3; back += 1) {
        await makeLog(habit.id, { date: addDays(date, -back), status: "done" });
      }

      const body = await getJson(api, `/api/day/${date}`);
      assert.equal(body.habits[0].streak, 3, "today is not yet due");
      assert.equal(body.habits[0].verdict, "future");
    });
  });

  it("shows weekly habits their progress toward the week", async () => {
    await withApi(async ({ api }) => {
      const date = today();
      const habit = await makeHabit({
        start_date: startOfWeek(date),
        schedule: { schedule_kind: "weekly", weekly_target: 3 },
      });
      await makeLog(habit.id, { date: startOfWeek(date), status: "done" });

      const body = await getJson(api, `/api/day/${date}`);
      assert.equal(body.habits[0].schedule_kind, "weekly");
      assert.deepEqual(body.habits[0].week, { done: 1, target: 3, met: false });
    });
  });

  it("includes unscheduled habits, flagged, so a bonus needs no second request", async () => {
    await withApi(async ({ api }) => {
      const date = today();
      const otherDay = (isoWeekday(date) % 7) + 1; // any weekday but today's
      await makeHabit({ start_date: addDays(date, -10), schedule: { schedule_days: [otherDay] } });

      const body = await getJson(api, `/api/day/${date}`);
      assert.equal(body.habits.length, 1, "it is still listed");
      assert.equal(body.habits[0].scheduled, false);
      assert.equal(body.habits[0].verdict, "unscheduled");
    });
  });

  /**
   * Pausing is a fact about the habit; the verdict is a claim about the day, and
   * the two come apart exactly when the day was worked. `dayVerdict` checks
   * "done" before it checks paused — deliberately, so a day earned during a
   * pause still shows — which means a paused habit that was ticked reports
   * "bonus". The client used to read paused-ness off the verdict, so ticking a
   * habit and then pausing it left the Day screen showing no pause at all and
   * offering no way to resume. `paused` is carried separately for that reason.
   */
  describe("a paused habit", () => {
    /** Paused a week ago, on a habit that runs Tue/Thu. */
    const pausedHabit = async (date) => {
      const habit = await makeHabit({
        name: "Morning run",
        start_date: addDays(date, -30),
        schedule: { schedule_days: [2, 4] },
      });
      await makeSchedule(habit.id, {
        effective_from: addDays(date, -7),
        schedule_kind: "paused",
      });
      return habit;
    };

    it("says so, and says what it will resume to", async () => {
      await withApi(async ({ api }) => {
        const date = today();
        await pausedHabit(date);

        const [row] = (await getJson(api, `/api/day/${date}`)).habits;
        assert.equal(row.paused, true);
        assert.equal(row.verdict, "paused");
        assert.equal(row.resumes_to.schedule_kind, "fixed");
        assert.deepEqual(row.resumes_to.schedule_days, [2, 4]);
      });
    });

    it("still says so on a day it was ticked, where the verdict reads 'bonus'", async () => {
      await withApi(async ({ api }) => {
        const date = today();
        const habit = await pausedHabit(date);
        await makeLog(habit.id, { date, status: "done" });

        const [row] = (await getJson(api, `/api/day/${date}`)).habits;
        assert.equal(row.verdict, "bonus", "a day worked during a pause is still a bonus");
        assert.equal(row.paused, true, "and the habit is still paused");
        assert.deepEqual(
          row.resumes_to.schedule_days,
          [2, 4],
          "so Resume is still offered, and still restores Tue/Thu",
        );
      });
    });

    it("carries the weekly target it will resume to, which a paused week never scores", async () => {
      await withApi(async ({ api }) => {
        const date = today();
        const habit = await makeHabit({
          start_date: addDays(date, -30),
          schedule: { schedule_kind: "weekly", weekly_target: 5 },
        });
        await makeSchedule(habit.id, {
          effective_from: addDays(date, -7),
          schedule_kind: "paused",
        });

        const [row] = (await getJson(api, `/api/day/${date}`)).habits;
        assert.equal(row.paused, true);
        assert.equal(row.week, null, "a paused week is not scored, which is why week is no source");
        assert.equal(row.resumes_to.weekly_target, 5);
      });
    });

    it("reports neither on a habit that is running", async () => {
      await withApi(async ({ api }) => {
        const date = today();
        await makeHabit({ start_date: addDays(date, -10) });

        const [row] = (await getJson(api, `/api/day/${date}`)).habits;
        assert.equal(row.paused, false);
        assert.equal(row.resumes_to, null);
      });
    });
  });

  it("omits habits that had not started or were already archived", async () => {
    await withApi(async ({ api }) => {
      const date = today();
      await makeHabit({ name: "Not yet", start_date: addDays(date, 1) });

      const body = await getJson(api, `/api/day/${date}`);
      assert.equal(body.habits.length, 0);
    });
  });

  /**
   * Archiving is meant to take a habit off the list, and the list is today's.
   * It used to keep it until midnight — archived_on is on or after today, which
   * is the rule that (correctly) keeps it on every past day — so the habit sat
   * there, still tickable, immediately after being put away.
   */
  describe("a habit archived today", () => {
    const archivedNow = (date) =>
      makeHabit({
        name: "Cold shower",
        start_date: addDays(date, -30),
        archived_at: new Date(),
      });

    it("is gone from today at once", async () => {
      await withApi(async ({ api }) => {
        const date = today();
        await archivedNow(date);

        const body = await getJson(api, `/api/day/${date}`);
        assert.deepEqual(
          body.habits.map((habit) => habit.name),
          [],
        );
      });
    });

    it("is still on the days it was actually lived", async () => {
      await withApi(async ({ api }) => {
        const date = today();
        const habit = await archivedNow(date);
        const yesterday = addDays(date, -1);
        await makeLog(habit.id, { date: yesterday, status: "done" });

        const body = await getJson(api, `/api/day/${yesterday}`);
        const [row] = body.habits;
        assert.equal(row.name, "Cold shower", "a past day is a record, not a list");
        assert.equal(row.status, "done", "and the day it was logged is still editable");
      });
    });

    it("keeps its history in the grid, said to be archived", async () => {
      await withApi(async ({ api }) => {
        const date = today();
        const habit = await archivedNow(date);
        await makeLog(habit.id, { date: addDays(date, -1), status: "done" });

        const body = await getJson(api, `/api/grid?weeks=4`);
        const [row] = body.habits;
        assert.equal(row.name, "Cold shower");
        assert.equal(row.archived_on, date, "the grid says when, rather than just stopping");
        assert.ok(row.cells.includes("d"), "and keeps the days that were logged");
      });
    });
  });

  it("rejects an impossible date", async () => {
    await withApi(async ({ api }) => {
      assert.equal((await api("/api/day/2026-02-31")).status, 400);
      assert.equal((await api("/api/day/nonsense")).status, 400);
    });
  });
});

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

describe("GET /api/grid", () => {
  it("always spans whole Monday-to-Sunday weeks", async () => {
    await withApi(async ({ api }) => {
      await makeHabit({ start_date: addDays(today(), -100) });

      const body = await getJson(api, "/api/grid?end=2026-09-11&weeks=12");

      // 2026-09-11 is a Friday; the grid runs to that week's Sunday.
      assert.equal(body.start, "2026-06-22");
      assert.equal(body.end, "2026-09-13");
      assert.equal(body.weeks, 12);
      assert.equal(body.habits[0].cells.length, 84, "weeks * 7");
    });
  });

  it("produces weeks * 7 cells for every width, whatever weekday it ends on", async () => {
    await withApi(async ({ api }) => {
      await makeHabit({ start_date: addDays(today(), -400) });

      for (const end of ["2026-09-07", "2026-09-11", "2026-09-13"]) {
        for (const weeks of [1, 4, 12]) {
          const body = await getJson(api, `/api/grid?end=${end}&weeks=${weeks}`);
          assert.equal(body.habits[0].cells.length, weeks * 7, `${end} / ${weeks}`);
          assert.equal(body.start, startOfWeek(body.start), "starts on a Monday");
          assert.equal(body.end, endOfWeek(body.end), "ends on a Sunday");
        }
      }
    });
  });

  it("spans a year boundary without a special case", async () => {
    await withApi(async ({ api }) => {
      await makeHabit({ start_date: "2026-11-01" });
      const body = await getJson(api, "/api/grid?end=2027-01-05&weeks=6");

      assert.equal(body.end, "2027-01-10");
      assert.equal(body.habits[0].cells.length, 42);
    });
  });

  it("defaults to twelve weeks ending today", async () => {
    await withApi(async ({ api }) => {
      await makeHabit({ start_date: addDays(today(), -100) });
      const body = await getJson(api, "/api/grid");

      assert.equal(body.weeks, 12);
      assert.equal(body.end, endOfWeek(today()));
      assert.equal(body.habits[0].cells.length, 84);
    });
  });

  /**
   * The default range already contains future days whenever today is not a
   * Sunday, so refusing an explicitly future end would be incoherent.
   */
  it("accepts a future end and marks those days not yet due", async () => {
    await withApi(async ({ api }) => {
      await makeHabit({ start_date: addDays(today(), -30) });
      const body = await getJson(api, `/api/grid?end=${addDays(today(), 30)}&weeks=2`);

      assert.ok(body.habits[0].cells.endsWith("f"), "the last day is in the future");
    });
  });

  it("rejects an out-of-range or non-numeric width", async () => {
    await withApi(async ({ api }) => {
      // 261 weeks — five years — is the ceiling. Past it this is an export,
      // and /api/export is the endpoint for that.
      for (const weeks of ["0", "262", "abc", "-1", "1.5", ""]) {
        const response = await api(`/api/grid?weeks=${weeks}`);
        assert.equal(response.status, 400, `weeks=${JSON.stringify(weeks)}`);
      }
      assert.equal((await api("/api/grid?end=2026-02-31")).status, 400);
    });
  });

  /*
   * The long ranges the Pattern screen offers. They are cheap — a day is one
   * character — and the reason the ceiling moved off a single year: reading the
   * record across several of them is a thing this product is for.
   */
  it("serves a multi-year range, whole weeks all the way back", async () => {
    await withApi(async ({ api }) => {
      await makeHabit({ start_date: addDays(today(), -700) });

      for (const weeks of [52, 104, 261]) {
        const body = await getJson(api, `/api/grid?weeks=${weeks}`);
        assert.equal(body.weeks, weeks, `weeks=${weeks}`);
        assert.equal(body.habits[0].cells.length, weeks * 7, `weeks=${weeks}`);
      }
    });
  });

  it("encodes each verdict as its documented character", async () => {
    await withApi(async ({ api }) => {
      // A week Mon..Sun, scheduled every day, with one of each state.
      const monday = "2026-09-07";
      const habit = await makeHabit({ start_date: monday, schedule: false });
      await makeSchedule(habit.id, { effective_from: monday, schedule_days: EVERY_DAY });

      await makeLog(habit.id, { date: "2026-09-07", status: "done" });
      await makeLog(habit.id, { date: "2026-09-08", status: "missed" });
      await makeLog(habit.id, { date: "2026-09-09", status: "skipped" });
      // 2026-09-10 deliberately left with no row at all.

      const body = await getJson(api, "/api/grid?end=2026-09-11&weeks=1");
      assert.equal(body.start, monday);
      assert.equal(body.habits[0].cells.slice(0, 4), "dmsu");
    });
  });

  it("marks paused days neutral and pre-start days inactive", async () => {
    await withApi(async ({ api }) => {
      const monday = "2026-09-07";
      const habit = await makeHabit({ start_date: "2026-09-09", schedule: false });
      await makeSchedule(habit.id, { effective_from: "2026-09-09", schedule_kind: "paused" });

      const body = await getJson(api, "/api/grid?end=2026-09-11&weeks=1");
      assert.equal(body.start, monday);
      // Mon, Tue before it existed; Wed onward paused.
      assert.equal(body.habits[0].cells.slice(0, 4), "--pp");
    });
  });

  it("reports per-week targets for weekly habits only", async () => {
    await withApi(async ({ api }) => {
      const weeklyHabit = await makeHabit({
        name: "Gym",
        start_date: "2026-09-07",
        schedule: { schedule_kind: "weekly", weekly_target: 2 },
      });
      await makeLog(weeklyHabit.id, { date: "2026-09-07", status: "done" });
      await makeLog(weeklyHabit.id, { date: "2026-09-08", status: "done" });
      await makeHabit({ name: "Read", start_date: "2026-09-07" });

      const body = await getJson(api, "/api/grid?end=2026-09-11&weeks=1");
      const byName = Object.fromEntries(body.habits.map((habit) => [habit.name, habit]));

      assert.equal(byName.Read.weeks, null, "a fixed row is described by its cells");
      assert.deepEqual(byName.Gym.weeks, [{ start: "2026-09-07", done: 2, target: 2, met: true }]);
    });
  });
});

// ---------------------------------------------------------------------------
// The monthly review
// ---------------------------------------------------------------------------

describe("GET /api/review/:month", () => {
  it("summarises a finished month", async () => {
    await withApi(async ({ api }) => {
      const habit = await makeHabit({ name: "Read", start_date: "2026-01-01" });
      for (const day of ["01", "02", "03", "04"]) {
        await makeLog(habit.id, { date: `2026-01-${day}`, status: "done" });
      }
      await makeLog(habit.id, { date: "2026-01-05", status: "missed" });
      await makeLog(habit.id, { date: "2026-01-06", status: "skipped" });

      const body = await getJson(api, "/api/review/2026-01");

      assert.equal(body.month, "2026-01");
      assert.equal(body.start, "2026-01-01");
      assert.equal(body.end, "2026-01-31");

      const [summary] = body.habits;
      assert.equal(summary.done, 4);
      assert.equal(summary.missed, 1);
      assert.equal(summary.skipped, 1);
      assert.equal(summary.unlogged, 25, "the rest of January was never logged");
      // Skipped leaves the denominator: 4 done out of 30 decided days.
      assert.equal(summary.done_of, 30);
      assert.ok(Math.abs(summary.consistency - 4 / 30) < 1e-9);
    });
  });

  /**
   * Regression: the review loads only the month's logs, so measuring the streak
   * from today walked over days it never fetched and reported zero for every
   * habit in every past month.
   */
  it("reports the streak as it stood at the end of a past month", async () => {
    await withApi(async ({ api }) => {
      const habit = await makeHabit({ name: "Read", start_date: "2026-01-01" });
      for (const date of eachDay("2026-01-01", "2026-01-31")) {
        await makeLog(habit.id, { date, status: "done" });
      }

      const body = await getJson(api, "/api/review/2026-01");
      const [summary] = body.habits;

      assert.equal(summary.done, 31);
      assert.equal(summary.current_streak, 31, "a finished month must not report zero");
      assert.equal(summary.longest_streak, 31);
    });
  });

  /**
   * A retired habit spends its last days unlogged, so its rate over the stub of
   * month it lived reads near zero — which the review presented as a current
   * failure. It reports when the habit was archived instead, and the client
   * decides that from `archived_on` against the month's `end`, never against
   * today: a habit archived later was alive for all of an earlier month, and
   * that month has to keep reading the way it was lived.
   */
  describe("archived_on", () => {
    /** Ran all January, abandoned in February, archived on the 10th. */
    const retiredInFebruary = async () => {
      const habit = await makeHabit({
        name: "Cold shower",
        start_date: "2026-01-01",
        archived_at: "2026-02-10T09:00:00Z",
      });
      for (const date of eachDay("2026-01-01", "2026-01-31")) {
        await makeLog(habit.id, { date, status: "done" });
      }
      return habit;
    };

    it("is reported for the month the habit retired in", async () => {
      await withApi(async ({ api }) => {
        await retiredInFebruary();

        const [summary] = (await getJson(api, "/api/review/2026-02")).habits;
        assert.equal(summary.archived_on, "2026-02-10");
        assert.equal(summary.unlogged, 10, "the days it quietly stopped are still counted");
        assert.equal(summary.consistency, 0, "the rate is still reported, and still zero");
      });
    });

    /**
     * The historical half, and the one that is easy to get wrong: January must
     * not learn about an archiving that happened in February.
     */
    it("is left in the future for a month the habit was alive through", async () => {
      await withApi(async ({ api }) => {
        await retiredInFebruary();

        const body = await getJson(api, "/api/review/2026-01");
        const [summary] = body.habits;

        assert.equal(summary.archived_on, "2026-02-10");
        assert.ok(summary.archived_on > body.end, "so January reads as the month it was");
        assert.equal(summary.consistency, 1, "a full January is still a full January");
        assert.equal(summary.current_streak, 31);
      });
    });

    it("is null for a habit that is still running", async () => {
      await withApi(async ({ api }) => {
        await makeHabit({ name: "Read", start_date: "2026-01-01" });

        const [summary] = (await getJson(api, "/api/review/2026-01")).habits;
        assert.equal(summary.archived_on, null);
      });
    });
  });

  it("carries the journal for the month", async () => {
    await withApi(async ({ api }) => {
      await api("/api/journal/month/2026-01", { method: "PUT", body: { entry: "Steady." } });
      await api("/api/journal/day/2026-01-04", { method: "PUT", body: { entry: "Rest day." } });

      const body = await getJson(api, "/api/review/2026-01");
      assert.equal(body.journal.month.entry, "Steady.");
      assert.equal(body.journal.days.length, 1);
      assert.equal(body.journal.days[0].date, "2026-01-04");
    });
  });

  it("counts tasks completed in the month", async () => {
    await withApi(async ({ api }) => {
      await makeTask({ title: "Done", completed: true, completed_at: "2026-01-15T10:00:00Z" });
      await makeTask({ title: "Later", completed: true, completed_at: "2026-02-15T10:00:00Z" });

      const body = await getJson(api, "/api/review/2026-01");
      assert.equal(body.tasks.completed, 1);
    });
  });

  it("rejects a malformed month", async () => {
    await withApi(async ({ api }) => {
      for (const month of ["2026-13", "2026-1", "nonsense"]) {
        assert.equal((await api(`/api/review/${month}`)).status, 400, month);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe("GET /api/export", () => {
  it("returns every table, archived rows included", async () => {
    await withApi(async ({ api }) => {
      const habit = await makeHabit({ name: "Read", start_date: "2026-01-05" });
      await makeLog(habit.id, { date: "2026-01-05", status: "done" });
      await makeTask({ title: "Archived task", archived_at: "2026-01-06T10:00:00Z" });
      await api("/api/journal/day/2026-01-05", { method: "PUT", body: { entry: "Hello." } });
      await makeProblem({ title: "Archived problem", archived_at: "2026-01-06T10:00:00Z" });

      const response = await api("/api/export");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-disposition"), /attachment; filename=/);

      const body = await response.json();
      // 5 since reminders: habits and tasks carry reminder_at, and the one
      // settings row is a table in the document — see the export controller.
      assert.equal(body.version, 5);
      assert.ok(body.exported_at);
      assert.equal(body.habits.length, 1);
      assert.equal(body.habit_schedules.length, 1);
      assert.equal(body.habit_logs.length, 1);
      assert.equal(body.journal.length, 1);
      assert.equal(body.tasks.length, 1, "an archived task is still part of the backup");
      assert.equal(body.leetcode_problems.length, 1, "and so is an archived problem");
      assert.equal(body.app_settings.length, 1, "the settings row is part of the backup");
      assert.equal(
        body.reminder_deliveries,
        undefined,
        "a week of dedupe state is not a record of anything",
      );
    });
  });

  it("carries raw rows rather than anything computed", async () => {
    await withApi(async ({ api }) => {
      const habit = await makeHabit({ start_date: "2026-01-05" });
      await makeLog(habit.id, { date: "2026-01-05", status: "done" });

      const body = await (await api("/api/export")).json();
      assert.equal(body.habit_logs[0].date, "2026-01-05");
      assert.equal(body.habit_logs[0].status, "done");
      assert.equal(body.habit_logs[0].habit_id, habit.id);
      assert.equal(body.streaks, undefined, "nothing derived belongs in a backup");
    });
  });

  /**
   * The screenshot is a reference now, and a reference fits in a JSON document —
   * which is why it moved out of the database. A restored row points at the same
   * Cloudinary asset it always did, rather than at bytes only a pg_dump had.
   */
  it("carries the screenshot's asset reference, and no bytes", async () => {
    await withApi(async ({ api }) => {
      await makeProblem({
        title: "LRU Cache",
        screenshot_public_id: "habit-tracker/leetcode/abc",
        screenshot_format: "png",
        screenshot_width: 1024,
        screenshot_height: 768,
        screenshot_bytes: 4096,
      });

      const [exported] = (await getJson(api, "/api/export")).leetcode_problems;
      assert.equal(exported.screenshot_public_id, "habit-tracker/leetcode/abc");
      assert.equal(exported.screenshot_format, "png");
      assert.equal(exported.screenshot_bytes, 4096);
      assert.ok(!("screenshot" in exported), "and nothing that is an image");
    });
  });
});

/** A brand-new install has no rows at all; nothing may divide by it or crash. */
describe("an empty database", () => {
  it("answers every read endpoint with empty content, not an error", async () => {
    await withApi(async ({ api }) => {
      const day = await getJson(api, `/api/day/${today()}`);
      assert.deepEqual(day.habits, []);
      assert.deepEqual(day.tasks, { due: [], overdue: [] });
      assert.equal(day.journal, null);

      const grid = await getJson(api, "/api/grid?weeks=4");
      assert.deepEqual(grid.habits, []);
      assert.equal(grid.end, endOfWeek(today()));

      const review = await getJson(api, `/api/review/${today().slice(0, 7)}`);
      assert.deepEqual(review.habits, []);
      assert.equal(review.tasks.completed, 0);
      assert.deepEqual(review.journal.days, []);
      assert.equal(review.journal.month, null);

      const exported = await getJson(api, "/api/export");
      for (const table of ["habits", "habit_schedules", "habit_logs", "tasks", "journal"]) {
        assert.deepEqual(exported[table], [], table);
      }
    });
  });

  it("reviews a month that predates every habit", async () => {
    await withApi(async ({ api }) => {
      await makeHabit({ start_date: "2026-06-01" });
      const review = await getJson(api, "/api/review/2020-01");
      assert.deepEqual(review.habits, []);
    });
  });
});

describe("the auth boundary", () => {
  it("refuses every read endpoint without a session", async () => {
    await withApi(async ({ request }) => {
      for (const path of [
        "/api/day/2026-01-05",
        "/api/grid",
        "/api/review/2026-01",
        "/api/export",
      ]) {
        assert.equal((await request(path)).status, 401, path);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Quantity, across the read models
// ---------------------------------------------------------------------------

/**
 * The two halves of quantity, side by side and never merged.
 *
 * Occurrence consistency answers "did I show up as often as I said I would" and
 * is binding: it drives `met` and both streaks. Attainment answers "when I
 * showed up, how close did I get" and is descriptive: it drives nothing. A
 * habit can honestly score 100% on one and 60% on the other, and the point of
 * these tests is that neither number can move the other.
 */
describe("quantity on /api/day", () => {
  it("carries the unit, the day's target and the measured value", async () => {
    await withApi(async ({ api }) => {
      const date = today();
      const habit = await makeHabit({
        name: "Run",
        unit: "km",
        start_date: addDays(date, -10),
        schedule: { target_value: 5 },
      });
      await makeLog(habit.id, { date, status: "done", value: 3 });

      const body = await getJson(api, `/api/day/${date}`);
      const row = body.habits[0];

      assert.equal(row.unit, "km");
      assert.equal(row.target_value, 5);
      assert.equal(row.value, 3);
      // Quantity never touches the claim or what the day amounted to.
      assert.equal(row.status, "done");
      assert.equal(row.verdict, "done");
    });
  });

  it("reports the target in force on the day being read, not today's", async () => {
    await withApi(async ({ api }) => {
      const date = today();
      const start = addDays(date, -20);
      const habit = await makeHabit({
        name: "Run",
        unit: "km",
        start_date: start,
        schedule: { target_value: 5 },
      });
      await makeSchedule(habit.id, {
        effective_from: addDays(date, -5),
        schedule_days: EVERY_DAY,
        target_value: 10,
      });

      const then = await getJson(api, `/api/day/${addDays(date, -10)}`);
      const now = await getJson(api, `/api/day/${date}`);

      assert.equal(
        then.habits[0].target_value,
        5,
        "a past day keeps the target it was lived under",
      );
      assert.equal(now.habits[0].target_value, 10);
    });
  });

  it("reports nulls for a binary habit", async () => {
    await withApi(async ({ api }) => {
      const date = today();
      const habit = await makeHabit({ name: "Read", start_date: addDays(date, -10) });
      await makeLog(habit.id, { date, status: "done" });

      const body = await getJson(api, `/api/day/${date}`);
      const row = body.habits[0];

      assert.equal(row.unit, null);
      assert.equal(row.target_value, null);
      assert.equal(row.value, null);
    });
  });

  it("reports no target while paused, and the one it will resume to", async () => {
    await withApi(async ({ api }) => {
      const date = today();
      const habit = await makeHabit({
        name: "Run",
        unit: "km",
        start_date: addDays(date, -20),
        schedule: { target_value: 5 },
      });
      await makeSchedule(habit.id, {
        effective_from: addDays(date, -3),
        schedule_kind: "paused",
        schedule_days: null,
      });

      const body = await getJson(api, `/api/day/${date}`);
      const row = body.habits[0];

      assert.equal(row.paused, true);
      assert.equal(row.target_value, null, "a pause asks for nothing");
      assert.equal(row.resumes_to.target_value, 5);
    });
  });
});

describe("quantity on /api/review/:month", () => {
  /*
   * A fixed month in the past, and habits archived after their last logged day.
   *
   * The month has to be wholly behind us or the review's window stops at today
   * and the assertions move with the calendar. The archiving is what bounds the
   * other end: without it every remaining day of March is a scheduled day with
   * no row, so consistency would measure the empty rest of the month rather
   * than the days the test is about.
   */
  const MONTH = "2026-03";
  const DAY_ONE = "2026-03-02";
  const endOn = (date) => `${date}T12:00:00Z`;

  const measuredHabit = (overrides = {}) =>
    makeHabit({
      name: "Run",
      unit: "km",
      start_date: DAY_ONE,
      schedule: { effective_from: DAY_ONE, target_value: 5 },
      ...overrides,
    });

  it("reports attainment beside consistency, and does not fold one into the other", async () => {
    await withApi(async ({ api }) => {
      const habit = await measuredHabit({ archived_at: endOn(addDays(DAY_ONE, 2)) });

      // Three days, all done, every one short. Showing up without reaching the
      // target: occurrence consistency full, attainment 60%. Both true at once,
      // which is the entire reason they are two numbers.
      for (let index = 0; index < 3; index += 1) {
        await makeLog(habit.id, { date: addDays(DAY_ONE, index), status: "done", value: 3 });
      }

      const row = (await getJson(api, `/api/review/${MONTH}`)).habits[0];

      assert.equal(row.unit, "km");
      assert.equal(row.consistency, 1, "every scheduled day was done");
      assert.ok(Math.abs(row.attainment - 0.6) < 1e-9, `attainment was ${row.attainment}`);
      assert.equal(row.attainment_of, 3);
    });
  });

  it("counts only measured done days in the denominator", async () => {
    await withApi(async ({ api }) => {
      const habit = await measuredHabit({ archived_at: endOn(addDays(DAY_ONE, 3)) });

      await makeLog(habit.id, { date: DAY_ONE, status: "done", value: 5 });
      // Done but not measured: a full occurrence, and not a sample.
      await makeLog(habit.id, { date: addDays(DAY_ONE, 1), status: "done" });
      // Measured, but the claim is a miss: a record, never a score.
      await makeLog(habit.id, { date: addDays(DAY_ONE, 2), status: "missed", value: 4 });
      // A rest day worked anyway: out of both.
      await makeLog(habit.id, { date: addDays(DAY_ONE, 3), status: "skipped", value: 5 });

      const row = (await getJson(api, `/api/review/${MONTH}`)).habits[0];

      assert.equal(row.attainment_of, 1, "only the one measured done day is a sample");
      assert.equal(row.attainment, 1);
    });
  });

  it("reports null attainment for a binary habit", async () => {
    await withApi(async ({ api }) => {
      const habit = await makeHabit({
        name: "Read",
        start_date: DAY_ONE,
        archived_at: endOn(DAY_ONE),
      });
      await makeLog(habit.id, { date: DAY_ONE, status: "done" });

      const row = (await getJson(api, `/api/review/${MONTH}`)).habits[0];

      assert.equal(row.unit, null);
      // Null, not zero: nothing was ever being measured, which is not the same
      // as measuring and falling short.
      assert.equal(row.attainment, null);
      assert.equal(row.attainment_of, 0);
    });
  });

  /*
   * The architectural claim, checked end to end rather than only in the pure
   * tests: values reach lib/attainment.js and nothing else, so a quantity habit
   * that fell short every single day scores exactly as a binary one that did the
   * same days.
   */
  it("gives a quantity habit and a binary habit the same streak and consistency", async () => {
    await withApi(async ({ api }) => {
      const archived = endOn(addDays(DAY_ONE, 2));
      const measured = await measuredHabit({ sort_order: 1, archived_at: archived });
      const binary = await makeHabit({
        name: "Read",
        sort_order: 2,
        start_date: DAY_ONE,
        archived_at: archived,
      });

      for (let index = 0; index < 3; index += 1) {
        const date = addDays(DAY_ONE, index);
        await makeLog(measured.id, { date, status: "done", value: 1 });
        await makeLog(binary.id, { date, status: "done" });
      }

      const body = await getJson(api, `/api/review/${MONTH}`);
      const [a, b] = body.habits;

      assert.equal(a.consistency, b.consistency);
      assert.equal(a.current_streak, b.current_streak);
      assert.equal(a.longest_streak, b.longest_streak);

      // ...while attainment sees exactly what the streaks cannot.
      assert.ok(Math.abs(a.attainment - 0.2) < 1e-9, `attainment was ${a.attainment}`);
      assert.equal(b.attainment, null);
    });
  });
});

describe("the export carries quantity in its new shape", () => {
  it("puts the target on the schedule version", async () => {
    await withApi(async ({ api }) => {
      const habit = await makeHabit({
        name: "Run",
        unit: "km",
        start_date: "2026-01-05",
        schedule: { effective_from: "2026-01-05", target_value: 5 },
      });
      await makeLog(habit.id, { date: "2026-01-05", status: "done", value: 3.5 });

      const body = await getJson(api, "/api/export");

      const exported = body.habits.find((row) => row.id === habit.id);
      assert.equal(exported.unit, "km");
      assert.ok(!("target_value" in exported), "the target no longer belongs to the habit");

      const version = body.habit_schedules.find((row) => row.habit_id === habit.id);
      assert.equal(version.target_value, 5);

      const log = body.habit_logs.find((row) => row.habit_id === habit.id);
      assert.equal(log.value, 3.5);
    });
  });
});
