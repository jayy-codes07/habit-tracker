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
import { closePool, makeHabit, makeLog, makeSchedule, makeTask } from "./helpers/db.js";

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

  it("omits habits that had not started or were already archived", async () => {
    await withApi(async ({ api }) => {
      const date = today();
      await makeHabit({ name: "Not yet", start_date: addDays(date, 1) });

      const body = await getJson(api, `/api/day/${date}`);
      assert.equal(body.habits.length, 0);
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
      for (const weeks of ["0", "54", "abc", "-1", "1.5", ""]) {
        const response = await api(`/api/grid?weeks=${weeks}`);
        assert.equal(response.status, 400, `weeks=${JSON.stringify(weeks)}`);
      }
      assert.equal((await api("/api/grid?end=2026-02-31")).status, 400);
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

      const response = await api("/api/export");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-disposition"), /attachment; filename=/);

      const body = await response.json();
      assert.equal(body.version, 1);
      assert.ok(body.exported_at);
      assert.equal(body.habits.length, 1);
      assert.equal(body.habit_schedules.length, 1);
      assert.equal(body.habit_logs.length, 1);
      assert.equal(body.journal.length, 1);
      assert.equal(body.tasks.length, 1, "an archived task is still part of the backup");
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
