/**
 * Habit, schedule and log routes.
 *
 * These go through a real HTTP request into a real database, inside a
 * transaction that is rolled back afterwards. The rules being checked are the
 * ones that protect data: a habit with history cannot be hard-deleted, a
 * schedule change cannot rewrite the past, and a partial reorder writes nothing.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { query } from "../src/db/index.js";
import { addDays, startOfWeek, today } from "../src/lib/dates.js";
import { createHabit } from "../src/modules/habits/habits.service.js";
import { withApi } from "./helpers/api.js";
import { closePool, makeLog } from "./helpers/db.js";

after(closePool);

const FIXED_DAILY = { schedule_kind: "fixed", schedule_days: [1, 2, 3, 4, 5, 6, 7] };

const newHabit = (overrides = {}) => ({
  name: "Morning run",
  color_token: "chart-1",
  schedule: FIXED_DAILY,
  ...overrides,
});

/** Creates a habit through the API and returns the presented row. */
async function create(api, overrides) {
  const response = await api("/api/habits", { method: "POST", body: newHabit(overrides) });
  assert.equal(response.status, 201, "habit creation should succeed");
  return (await response.json()).habit;
}

describe("creating a habit", () => {
  it("stores it with its first schedule version", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { start_date: "2026-01-05" });

      assert.equal(habit.name, "Morning run");
      assert.equal(habit.color_token, "chart-1");
      assert.equal(habit.start_date, "2026-01-05");
      assert.equal(habit.archived_on, null);
      assert.deepEqual(habit.schedule.schedule_days, [1, 2, 3, 4, 5, 6, 7]);
      assert.equal(habit.schedule.effective_from, "2026-01-05");
    });
  });

  /** bigint ids arrive from node-postgres as strings, and stay strings. */
  it("returns the id as a string", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);
      assert.equal(typeof habit.id, "string");
      assert.match(habit.id, /^\d+$/);
    });
  });

  it("starts today when no start date is given", async () => {
    await withApi(async ({ api }) => {
      assert.equal((await create(api)).start_date, today());
    });
  });

  it("appends each new habit to the end of the display order", async () => {
    await withApi(async ({ api }) => {
      const first = await create(api, { name: "First" });
      const second = await create(api, { name: "Second" });
      assert.ok(second.sort_order > first.sort_order, "new habits go last");
    });
  });

  it("accepts a weekly schedule", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, {
        schedule: { schedule_kind: "weekly", weekly_target: 3 },
      });
      assert.equal(habit.schedule.schedule_kind, "weekly");
      assert.equal(habit.schedule.weekly_target, 3);
      assert.equal(habit.schedule.schedule_days, null);
    });
  });

  it("rejects a malformed request with 400 and no habit", async () => {
    await withApi(async ({ api }) => {
      const cases = [
        ["blank name", newHabit({ name: "   " })],
        ["missing name", { color_token: "chart-1", schedule: FIXED_DAILY }],
        ["hex colour", newHabit({ color_token: "#ff0000" })],
        ["unknown colour token", newHabit({ color_token: "chart-9" })],
        [
          "weekly with days",
          newHabit({ schedule: { schedule_kind: "weekly", schedule_days: [1] } }),
        ],
        ["fixed with no days", newHabit({ schedule: { schedule_kind: "fixed" } })],
        ["weekday zero", newHabit({ schedule: { schedule_kind: "fixed", schedule_days: [0] } })],
        ["weekday eight", newHabit({ schedule: { schedule_kind: "fixed", schedule_days: [8] } })],
        [
          "duplicate weekdays",
          newHabit({ schedule: { schedule_kind: "fixed", schedule_days: [1, 1] } }),
        ],
        ["unknown schedule kind", newHabit({ schedule: { schedule_kind: "monthly" } })],
        ["impossible start date", newHabit({ start_date: "2026-02-31" })],
      ];

      for (const [label, body] of cases) {
        const response = await api("/api/habits", { method: "POST", body });
        assert.equal(response.status, 400, `${label} should be rejected`);
        assert.equal((await response.json()).error, "Invalid request", label);
      }

      const list = await (await api("/api/habits")).json();
      assert.equal(list.habits.length, 0, "nothing should have been stored");
    });
  });
});

describe("listing habits", () => {
  it("returns active habits in display order", async () => {
    await withApi(async ({ api }) => {
      await create(api, { name: "First" });
      await create(api, { name: "Second" });

      const { habits } = await (await api("/api/habits")).json();
      assert.deepEqual(
        habits.map((habit) => habit.name),
        ["First", "Second"],
      );
    });
  });

  it("hides archived habits unless they are asked for", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { name: "Gone" });
      await api(`/api/habits/${habit.id}`, { method: "PATCH", body: { archived: true } });

      const active = await (await api("/api/habits")).json();
      assert.equal(active.habits.length, 0);

      const all = await (await api("/api/habits?include=archived")).json();
      assert.equal(all.habits.length, 1);
      assert.equal(all.habits[0].archived_on, today());
    });
  });

  it("resolves the schedule in force today, not the first one ever", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { start_date: addDays(today(), -30) });
      await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: { schedule_kind: "fixed", schedule_days: [2, 4] },
      });

      const { habits } = await (await api("/api/habits")).json();
      assert.deepEqual(habits[0].schedule.schedule_days, [2, 4]);
    });
  });
});

describe("updating a habit", () => {
  it("changes only what was sent", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);
      const response = await api(`/api/habits/${habit.id}`, {
        method: "PATCH",
        body: { name: "Evening run" },
      });

      const updated = (await response.json()).habit;
      assert.equal(updated.name, "Evening run");
      assert.equal(updated.color_token, "chart-1", "colour must be untouched");
    });
  });

  it("archives and unarchives", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);

      const archived = await api(`/api/habits/${habit.id}`, {
        method: "PATCH",
        body: { archived: true },
      });
      assert.equal((await archived.json()).habit.archived_on, today());

      const restored = await api(`/api/habits/${habit.id}`, {
        method: "PATCH",
        body: { archived: false },
      });
      assert.equal((await restored.json()).habit.archived_on, null);
    });
  });

  /**
   * The numbers an archived habit left behind are handed out again by every
   * habit created after it, so restoring one at its old sort_order puts two
   * active habits on the same number — and a duplicate makes the display order
   * depend on the id tiebreak that the reorder screen cannot see or send.
   */
  it("restores a habit to the end of the active order, not onto its old number", async () => {
    await withApi(async ({ api }) => {
      const first = await create(api, { name: "First" });
      await api(`/api/habits/${first.id}`, { method: "PATCH", body: { archived: true } });

      // Both of these are numbered as if First had never existed.
      const second = await create(api, { name: "Second" });
      const third = await create(api, { name: "Third" });
      assert.equal(second.sort_order, first.sort_order, "the freed number is handed out again");

      const restored = await api(`/api/habits/${first.id}`, {
        method: "PATCH",
        body: { archived: false },
      });
      const back = (await restored.json()).habit;

      assert.equal(back.archived_on, null);
      assert.ok(
        back.sort_order > third.sort_order,
        `restored habit must come after every active one, got ${back.sort_order}`,
      );

      const { habits } = await (await api("/api/habits")).json();
      assert.deepEqual(
        habits.map((habit) => habit.name),
        ["Second", "Third", "First"],
      );
      assert.equal(
        new Set(habits.map((habit) => habit.sort_order)).size,
        habits.length,
        "no two active habits may share a sort_order",
      );

      // The whole point of the uniqueness: the order the screen was shown is
      // the order it can send back.
      const reorder = await api("/api/habits/order", {
        method: "PUT",
        body: { ids: habits.map((habit) => habit.id) },
      });
      assert.equal(reorder.status, 200);
    });
  });

  it("leaves the order alone when archived:false is a no-op", async () => {
    await withApi(async ({ api }) => {
      const first = await create(api, { name: "First" });
      const second = await create(api, { name: "Second" });

      const response = await api(`/api/habits/${first.id}`, {
        method: "PATCH",
        body: { archived: false },
      });

      const unchanged = (await response.json()).habit;
      assert.equal(
        unchanged.sort_order,
        first.sort_order,
        "an active habit must not be renumbered",
      );
      assert.ok(unchanged.sort_order < second.sort_order);
    });
  });

  it("rejects an empty patch and an unknown habit", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);

      const empty = await api(`/api/habits/${habit.id}`, { method: "PATCH", body: {} });
      assert.equal(empty.status, 400);

      const missing = await api("/api/habits/999999", { method: "PATCH", body: { name: "x" } });
      assert.equal(missing.status, 404);
    });
  });
});

/**
 * The rule that keeps a tap from destroying months of data: you can delete a
 * mistake, you must archive a history.
 */
describe("deleting a habit", () => {
  it("deletes one that was never logged", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);
      const response = await api(`/api/habits/${habit.id}`, { method: "DELETE" });

      assert.equal(response.status, 204);
      const { habits } = await (await api("/api/habits?include=archived")).json();
      assert.equal(habits.length, 0);
    });
  });

  it("refuses one that has history, and keeps it intact", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { start_date: "2026-01-05" });
      await makeLog(habit.id, { date: "2026-01-05", status: "done" });

      const response = await api(`/api/habits/${habit.id}`, { method: "DELETE" });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /Archive it instead/);

      const { habits } = await (await api("/api/habits")).json();
      assert.equal(habits.length, 1, "the habit must survive");
    });
  });

  it("returns 404 for a habit that does not exist", async () => {
    await withApi(async ({ api }) => {
      assert.equal((await api("/api/habits/999999", { method: "DELETE" })).status, 404);
    });
  });
});

describe("reordering habits", () => {
  it("rewrites the display order", async () => {
    await withApi(async ({ api }) => {
      const first = await create(api, { name: "First" });
      const second = await create(api, { name: "Second" });

      const response = await api("/api/habits/order", {
        method: "PUT",
        body: { ids: [second.id, first.id] },
      });

      assert.equal(response.status, 200);
      assert.deepEqual(
        (await response.json()).habits.map((habit) => habit.name),
        ["Second", "First"],
      );
    });
  });

  /** The reason this one needs a transaction: a rejected reorder must write nothing. */
  it("rejects a partial or unknown list without writing anything", async () => {
    await withApi(async ({ api }) => {
      const first = await create(api, { name: "First" });
      const second = await create(api, { name: "Second" });

      const cases = [
        ["a partial list", [second.id]],
        ["an unknown id", [second.id, first.id, "999999"]],
        ["a duplicate id", [second.id, second.id]],
      ];

      for (const [label, ids] of cases) {
        const response = await api("/api/habits/order", { method: "PUT", body: { ids } });
        assert.equal(response.status, 400, `${label} should be rejected`);
      }

      const { habits } = await (await api("/api/habits")).json();
      assert.deepEqual(
        habits.map((habit) => habit.name),
        ["First", "Second"],
        "the original order must be untouched",
      );
    });
  });
});

describe("changing a schedule", () => {
  it("appends a version that takes effect from today", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { start_date: addDays(today(), -10) });

      const response = await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: { schedule_kind: "fixed", schedule_days: [1, 3, 5] },
      });

      assert.equal(response.status, 201);
      const { schedule } = await response.json();
      assert.equal(schedule.effective_from, today());
      assert.deepEqual(schedule.schedule_days, [1, 3, 5]);
    });
  });

  /**
   * Without the upsert this is a 409 from the unique constraint, leaving a
   * schedule you just mistyped impossible to correct.
   */
  it("corrects a version set earlier the same day instead of colliding", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);
      const change = (days) =>
        api(`/api/habits/${habit.id}/schedule`, {
          method: "POST",
          body: { schedule_kind: "fixed", schedule_days: days },
        });

      assert.equal((await change([1, 3, 5])).status, 201);
      const corrected = await change([2, 4]);

      assert.equal(corrected.status, 201, "a same-day correction must not be a conflict");
      assert.deepEqual((await corrected.json()).schedule.schedule_days, [2, 4]);
    });
  });

  it("accepts a future change", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);
      const response = await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: { schedule_kind: "paused", effective_from: addDays(today(), 7) },
      });
      assert.equal(response.status, 201);
    });
  });

  /** Backdating is what would re-score history, so it is the thing refused. */
  it("refuses to backdate a change", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { start_date: addDays(today(), -10) });

      const response = await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: { schedule_kind: "fixed", schedule_days: [1], effective_from: addDays(today(), -1) },
      });

      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /cannot start in the past/);
    });
  });

  it("pauses and resumes", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);
      const paused = await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: { schedule_kind: "paused" },
      });

      assert.equal((await paused.json()).schedule.schedule_kind, "paused");

      const { habits } = await (await api("/api/habits")).json();
      assert.equal(habits[0].schedule.schedule_kind, "paused");
    });
  });

  it("returns 404 for an unknown habit", async () => {
    await withApi(async ({ api }) => {
      const response = await api("/api/habits/999999/schedule", {
        method: "POST",
        body: FIXED_DAILY,
      });
      assert.equal(response.status, 404);
    });
  });
});

/**
 * A change of scoring unit waits for Monday.
 *
 * Fixed counts days and weekly counts weeks, so a switch landing on a Thursday
 * would leave a week that is half a set of named days and half a count over
 * seven of them — neither a complete fixed period nor a complete weekly one, and
 * honestly scoreable as neither. The rule is enforced here, at the write, rather
 * than as a special case in every scoring read, and the stored effective_from
 * comes back in the response so the client can say when the change starts.
 *
 * Dates are derived from today's own week so the suite means the same thing
 * whatever weekday it runs on, and all of them are in the future, which
 * setSchedule requires.
 */
describe("a change of schedule kind", () => {
  const nextMonday = () => addDays(startOfWeek(today()), 7);
  const nextThursday = () => addDays(nextMonday(), 3);
  const mondayAfter = () => addDays(nextMonday(), 7);

  const WEEKLY = { schedule_kind: "weekly", weekly_target: 3 };

  const change = (api, id, body) => api(`/api/habits/${id}/schedule`, { method: "POST", body });

  const effectiveFrom = async (response) => {
    assert.equal(response.status, 201);
    return (await response.json()).schedule.effective_from;
  };

  it("defers fixed to weekly to the following Monday", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);
      const response = await change(api, habit.id, { ...WEEKLY, effective_from: nextThursday() });

      assert.equal(await effectiveFrom(response), mondayAfter());
    });
  });

  it("defers weekly to fixed to the following Monday", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { schedule: WEEKLY });
      const response = await change(api, habit.id, {
        ...FIXED_DAILY,
        effective_from: nextThursday(),
      });

      assert.equal(await effectiveFrom(response), mondayAfter());
    });
  });

  /** Already a week boundary, so there is nothing to defer. */
  it("leaves a change already dated to a Monday alone", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);
      const response = await change(api, habit.id, { ...WEEKLY, effective_from: nextMonday() });

      assert.equal(await effectiveFrom(response), nextMonday());
    });
  });

  /** Fixed to fixed only renames the days; each day is scored under its own version. */
  it("does not defer a change of days", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);
      const response = await change(api, habit.id, {
        schedule_kind: "fixed",
        schedule_days: [1, 3, 5],
        effective_from: nextThursday(),
      });

      assert.equal(await effectiveFrom(response), nextThursday());
    });
  });

  /** Saving the same schedule again must not move it, or pretend anything changed. */
  it("does not defer a no-op save", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);
      const response = await change(api, habit.id, {
        ...FIXED_DAILY,
        effective_from: nextThursday(),
      });

      assert.equal(await effectiveFrom(response), nextThursday());
      const { habits } = await (await api("/api/habits")).json();
      assert.deepEqual(habits[0].schedule.schedule_days, FIXED_DAILY.schedule_days);
    });
  });

  /**
   * A deferred change is invisible to a client that only ever sees the schedule
   * resolved as of today, so /habits reports the nearest version dated later
   * alongside it. Before this, a save that had worked perfectly looked exactly
   * like one that had failed the moment the list refetched.
   */
  describe("and what it leaves waiting", () => {
    const rowFor = async (api, id) => {
      const { habits } = await (await api("/api/habits")).json();
      return habits.find((habit) => habit.id === id);
    };

    it("reports nothing upcoming for a habit with no plans", async () => {
      await withApi(async ({ api }) => {
        const habit = await create(api);
        assert.equal(habit.next_schedule, null);
        assert.equal((await rowFor(api, habit.id)).next_schedule, null);
      });
    });

    it("reports a deferred switch to times a week, and keeps today's schedule", async () => {
      await withApi(async ({ api }) => {
        const habit = await create(api, {
          schedule: { schedule_kind: "fixed", schedule_days: [1, 3, 5] },
        });
        await change(api, habit.id, { ...WEEKLY, effective_from: nextThursday() });

        const row = await rowFor(api, habit.id);
        assert.deepEqual(row.schedule.schedule_days, [1, 3, 5], "today is unchanged");
        assert.equal(row.schedule.schedule_kind, "fixed");
        assert.equal(row.next_schedule.schedule_kind, "weekly");
        assert.equal(row.next_schedule.weekly_target, 3);
        assert.equal(row.next_schedule.schedule_days, null);
        assert.equal(row.next_schedule.effective_from, mondayAfter());
      });
    });

    it("reports a deferred switch to certain days the same way", async () => {
      await withApi(async ({ api }) => {
        const habit = await create(api, { schedule: WEEKLY });
        await change(api, habit.id, { ...FIXED_DAILY, effective_from: nextThursday() });

        const row = await rowFor(api, habit.id);
        assert.equal(row.schedule.schedule_kind, "weekly", "today is unchanged");
        assert.equal(row.schedule.weekly_target, 3);
        assert.equal(row.next_schedule.schedule_kind, "fixed");
        assert.deepEqual(row.next_schedule.schedule_days, [1, 2, 3, 4, 5, 6, 7]);
        assert.equal(row.next_schedule.effective_from, mondayAfter());
      });
    });

    /** Strictly later. A change that starts today is current, not upcoming. */
    it("does not report a change that takes effect today", async () => {
      await withApi(async ({ api }) => {
        const habit = await create(api);
        await change(api, habit.id, { schedule_kind: "fixed", schedule_days: [2, 4] });

        const row = await rowFor(api, habit.id);
        assert.deepEqual(row.schedule.schedule_days, [2, 4], "it is in force now");
        assert.equal(row.next_schedule, null);
      });
    });

    it("takes the nearest of several waiting versions", async () => {
      await withApi(async ({ api }) => {
        const habit = await create(api, { schedule: WEEKLY });
        await change(api, habit.id, { ...FIXED_DAILY, effective_from: addDays(nextMonday(), 21) });
        await change(api, habit.id, {
          schedule_kind: "paused",
          effective_from: addDays(nextMonday(), 7),
        });

        const row = await rowFor(api, habit.id);
        assert.equal(row.next_schedule.effective_from, addDays(nextMonday(), 7));
        assert.equal(row.next_schedule.schedule_kind, "paused");
      });
    });

    /** It is a projection of versions, not a state: scoring never sees it. */
    it("changes nothing about how today is scored", async () => {
      await withApi(async ({ api }) => {
        const habit = await create(api, {
          start_date: addDays(today(), -10),
          schedule: { schedule_kind: "fixed", schedule_days: [1, 2, 3, 4, 5, 6, 7] },
        });
        await change(api, habit.id, { ...WEEKLY, effective_from: nextThursday() });

        const day = await (await api(`/api/day/${today()}`)).json();
        const row = day.habits.find((entry) => entry.id === habit.id);

        assert.equal(row.schedule_kind, "fixed", "today is still governed by today's version");
        assert.equal(row.scheduled, true);
        assert.equal(row.week, null, "and is not being read as a weekly habit");
      });
    });

    /** Pausing is immediate, so it becomes current and leaves nothing waiting. */
    it("leaves pause and resume reporting exactly as before", async () => {
      await withApi(async ({ api }) => {
        // A month back: a version set today and paused today share an
        // effective_from, where the upsert replaces the first outright and
        // there is genuinely nothing left to resume to.
        const habit = await create(api, {
          start_date: addDays(today(), -30),
          schedule: { schedule_kind: "fixed", schedule_days: [2, 4] },
        });
        await change(api, habit.id, { schedule_kind: "paused" });

        const paused = await rowFor(api, habit.id);
        assert.equal(paused.schedule.schedule_kind, "paused");
        assert.deepEqual(paused.resumes_to.schedule_days, [2, 4]);
        assert.equal(paused.next_schedule, null);

        await change(api, habit.id, { schedule_kind: "fixed", schedule_days: [2, 4] });

        const resumed = await rowFor(api, habit.id);
        assert.equal(resumed.schedule.schedule_kind, "fixed");
        assert.equal(resumed.resumes_to, null);
        assert.equal(resumed.next_schedule, null);
      });
    });
  });

  /**
   * Pausing and resuming stay immediate — you pause because you are ill today,
   * and a week a pause splits is already provisional. Neither is a unit.
   */
  it("starts a pause and a resume on the day asked for", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { schedule: WEEKLY });

      const paused = await change(api, habit.id, {
        schedule_kind: "paused",
        effective_from: nextThursday(),
      });
      assert.equal(await effectiveFrom(paused), nextThursday());

      const friday = addDays(nextThursday(), 1);
      const resumed = await change(api, habit.id, { ...WEEKLY, effective_from: friday });
      assert.equal(await effectiveFrom(resumed), friday);
    });
  });
});

/**
 * What a paused habit resumes to.
 *
 * A paused version stores no days and no target, so a client that is told only
 * "paused" has to invent a schedule to resume on. It invented every-day, and
 * resuming a Tue/Thu habit quietly turned it into one that failed five days a
 * week — the same re-scoring of history the versioned schedule exists to stop,
 * arriving through the interface instead of the database. `resumes_to` is what
 * closes that hole, so these are its contract.
 */
describe("resumes_to", () => {
  const pause = (api, id) =>
    api(`/api/habits/${id}/schedule`, { method: "POST", body: { schedule_kind: "paused" } });

  const list = async (api) => (await (await api("/api/habits")).json()).habits;

  /**
   * A habit that has been running a while, so pausing it today *appends* a
   * version. Starting one today instead would put both versions on the same
   * effective_from, where setSchedule's upsert replaces the first outright —
   * the schedule is then genuinely gone rather than hidden, and null is the
   * honest answer. That is the documented "correct the version you just set"
   * behaviour, not something resumes_to can see around.
   */
  const running = (overrides) => ({ start_date: addDays(today(), -30), ...overrides });

  it("is null while the habit is not paused", async () => {
    await withApi(async ({ api }) => {
      await create(api);
      assert.equal((await list(api))[0].resumes_to, null);
    });
  });

  it("reports the exact fixed days a pause interrupted", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(
        api,
        running({ schedule: { schedule_kind: "fixed", schedule_days: [2, 4] } }),
      );
      await pause(api, habit.id);

      const [row] = await list(api);
      assert.equal(row.schedule.schedule_kind, "paused");
      assert.equal(row.resumes_to.schedule_kind, "fixed");
      assert.deepEqual(row.resumes_to.schedule_days, [2, 4], "Tue/Thu must survive the pause");
    });
  });

  it("reports the exact weekly target a pause interrupted", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(
        api,
        running({ schedule: { schedule_kind: "weekly", weekly_target: 5 } }),
      );
      await pause(api, habit.id);

      const [row] = await list(api);
      assert.equal(row.resumes_to.schedule_kind, "weekly");
      assert.equal(row.resumes_to.weekly_target, 5, "five a week must not come back as three");
    });
  });

  it("is null for a habit paused from its very first version", async () => {
    await withApi(async ({ api }) => {
      await create(api, { schedule: { schedule_kind: "paused" } });

      const [row] = await list(api);
      assert.equal(row.schedule.schedule_kind, "paused");
      assert.equal(row.resumes_to, null, "nothing was ever asked, so there is nothing to restore");
    });
  });

  /**
   * The corner this cannot see around, recorded so it is a known shape rather
   * than a surprise: both versions land on the same effective_from, so
   * setSchedule's upsert replaces the first instead of appending. The earlier
   * commitment is not hidden, it is gone, and the picker falls back to its
   * default. Widening the upsert to spare a pause would break the correction it
   * exists for.
   */
  it("is null when the pause lands on the same day the schedule was set", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, {
        schedule: { schedule_kind: "fixed", schedule_days: [2, 4] },
      });
      await pause(api, habit.id);

      assert.equal((await list(api))[0].resumes_to, null);
    });
  });

  /**
   * The round trip the interface actually performs: read resumes_to, post it
   * straight back. Every kind must land on exactly what it started as.
   */
  for (const [name, schedule] of [
    ["Tue/Thu", { schedule_kind: "fixed", schedule_days: [2, 4] }],
    ["weekdays", { schedule_kind: "fixed", schedule_days: [1, 2, 3, 4, 5] }],
    ["every day", FIXED_DAILY],
    ["a single day", { schedule_kind: "fixed", schedule_days: [7] }],
    ["five a week", { schedule_kind: "weekly", weekly_target: 5 }],
    ["once a week", { schedule_kind: "weekly", weekly_target: 1 }],
  ]) {
    it(`resumes ${name} unchanged`, async () => {
      await withApi(async ({ api }) => {
        const habit = await create(api, running({ schedule }));
        await pause(api, habit.id);

        const { resumes_to: resume } = (await list(api))[0];
        const response = await api(`/api/habits/${habit.id}/schedule`, {
          method: "POST",
          // Exactly what the pickers send back: the kind and its one payload.
          body:
            resume.schedule_kind === "weekly"
              ? { schedule_kind: "weekly", weekly_target: resume.weekly_target }
              : { schedule_kind: "fixed", schedule_days: resume.schedule_days },
        });
        assert.equal(response.status, 201);

        const [row] = await list(api);
        assert.equal(row.schedule.schedule_kind, schedule.schedule_kind);
        assert.deepEqual(row.schedule.schedule_days, schedule.schedule_days ?? null);
        assert.equal(row.schedule.weekly_target, schedule.weekly_target ?? null);
        assert.equal(row.resumes_to, null, "resuming clears the field");
      });
    });
  }
});

describe("logging a day", () => {
  const logPath = (id, date) => `/api/habits/${id}/logs/${date}`;

  it("records a status and then overwrites it", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { start_date: "2026-01-05" });

      const done = await api(logPath(habit.id, "2026-01-05"), {
        method: "PUT",
        body: { status: "done", note: "Felt good." },
      });
      assert.equal(done.status, 200);
      assert.equal((await done.json()).log.status, "done");

      const skipped = await api(logPath(habit.id, "2026-01-05"), {
        method: "PUT",
        body: { status: "skipped" },
      });
      assert.equal((await skipped.json()).log.status, "skipped");
    });
  });

  it("accepts all three statuses", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { start_date: "2026-01-05" });
      for (const status of ["done", "missed", "skipped"]) {
        const response = await api(logPath(habit.id, "2026-01-06"), {
          method: "PUT",
          body: { status },
        });
        assert.equal(response.status, 200, status);
      }
    });
  });

  /** Clearing returns the day to "never logged", which is a fourth state. */
  it("clears a log, idempotently", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { start_date: "2026-01-05" });
      await api(logPath(habit.id, "2026-01-05"), { method: "PUT", body: { status: "done" } });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await api(logPath(habit.id, "2026-01-05"), { method: "DELETE" });
        assert.equal(response.status, 204, `attempt ${attempt + 1}`);
      }
    });
  });

  it("rejects a bad status, a bad date, and a future day", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { start_date: "2026-01-05" });

      const badStatus = await api(logPath(habit.id, "2026-01-05"), {
        method: "PUT",
        body: { status: "completed" },
      });
      assert.equal(badStatus.status, 400);

      const badDate = await api(logPath(habit.id, "2026-02-31"), {
        method: "PUT",
        body: { status: "done" },
      });
      assert.equal(badDate.status, 400, "an impossible date must not reach Postgres");

      const future = await api(logPath(habit.id, addDays(today(), 1)), {
        method: "PUT",
        body: { status: "done" },
      });
      assert.equal(future.status, 400);
    });
  });

  it("returns 404, not 500, for an unknown habit", async () => {
    await withApi(async ({ api }) => {
      const response = await api(logPath("999999", "2026-01-05"), {
        method: "PUT",
        body: { status: "done" },
      });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).error, "No such habit");
    });
  });
});

/**
 * Regression: a digits-only id longer than bigint reached Postgres and raised
 * SQLSTATE 22003, which carries no status and so became a 500 — for what is only
 * ever a request for a row that cannot exist.
 */
describe("malformed ids", () => {
  it("rejects them with 400, never 500", async () => {
    await withApi(async ({ api }) => {
      const ids = [
        "99999999999999999999", // 20 digits: overflows bigint
        "9223372036854775808", // one past the maximum
        "abc",
        "1.5",
        "-1",
        "1e3",
      ];

      for (const id of ids) {
        for (const [method, path, body] of [
          ["PATCH", `/api/habits/${id}`, { name: "x" }],
          ["DELETE", `/api/habits/${id}`, undefined],
          ["POST", `/api/habits/${id}/schedule`, FIXED_DAILY],
          ["PUT", `/api/habits/${id}/logs/2026-01-05`, { status: "done" }],
        ]) {
          const response = await api(path, { method, body });
          assert.equal(response.status, 400, `${method} ${path}`);
        }
      }
    });
  });

  it("still accepts the largest id Postgres can hold", async () => {
    await withApi(async ({ api }) => {
      // Well-formed but absent, so this is a 404 rather than a validation error.
      const response = await api("/api/habits/9223372036854775807", {
        method: "PATCH",
        body: { name: "x" },
      });
      assert.equal(response.status, 404);
    });
  });

  it("rejects a malformed id in a reorder without touching the order", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { name: "Only" });
      const response = await api("/api/habits/order", {
        method: "PUT",
        body: { ids: ["99999999999999999999"] },
      });
      assert.equal(response.status, 400);

      const { habits } = await (await api("/api/habits")).json();
      assert.equal(habits[0].id, habit.id);
    });
  });
});

describe("the auth boundary", () => {
  it("refuses every habit route without a session", async () => {
    await withApi(async ({ request }) => {
      const routes = [
        ["GET", "/api/habits"],
        ["POST", "/api/habits"],
        ["PUT", "/api/habits/order"],
        ["PATCH", "/api/habits/1"],
        ["DELETE", "/api/habits/1"],
        ["POST", "/api/habits/1/schedule"],
        ["PUT", "/api/habits/1/logs/2026-01-05"],
        ["DELETE", "/api/habits/1/logs/2026-01-05"],
      ];

      for (const [method, path] of routes) {
        const response = await request(path, { method });
        assert.equal(response.status, 401, `${method} ${path}`);
      }
    });
  });
});

/**
 * Quantity habits.
 *
 * A habit is measured when, and only when, it has a unit — that is the whole
 * marker, and it is on the habit rather than on a schedule version because a
 * paused version holds no target and a paused quantity habit is still a
 * quantity habit.
 *
 * These cover the rules no CHECK constraint can hold, because they span two
 * tables or two points in time: a target needs a unit, a value needs a unit, and
 * a unit is frozen once anything has been measured in it.
 */
const QUANTITY = { unit: "km", schedule: { ...FIXED_DAILY, target_value: 5 } };

const logOn = (api, habit, body, date = today()) =>
  api(`/api/habits/${habit.id}/logs/${date}`, { method: "PUT", body });

describe("quantity habits", () => {
  it("creates one with a unit and a target on its first version", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);

      assert.equal(habit.unit, "km");
      assert.equal(habit.schedule.target_value, 5);
      // Locked from birth, and by the target alone: "5" is already a number in
      // kilometres, and it is history the moment it is stored. Nothing has been
      // measured yet, which used to be the whole test - see the unit-freeze
      // block below for why that was not enough.
      assert.equal(habit.unit_locked, true);
    });
  });

  it("creates a binary habit with no unit and no target", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);

      assert.equal(habit.unit, null);
      assert.equal(habit.schedule.target_value, null);
      assert.equal(habit.unit_locked, false);
    });
  });

  it("lets a quantity habit measure without aiming at anything", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { unit: "pages", schedule: FIXED_DAILY });

      assert.equal(habit.unit, "pages");
      assert.equal(habit.schedule.target_value, null);
    });
  });

  it("refuses a target on a habit with no unit", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);

      const response = await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: { ...FIXED_DAILY, target_value: 5 },
      });

      assert.equal(response.status, 400);
    });
  });

  /*
   * The same refusal at creation time, which used to be no refusal at all.
   *
   * createHabit inserts the habit and then its first version, and it ignored
   * insertVersion's null — so a target with no unit committed a habit with no
   * schedule version. That habit resolves to nothing on every date: `inactive`
   * on the day screen, a row of '-' on the grid, a null consistency on the
   * review, for ever, with nothing anywhere to say why. It is the exact state
   * the transaction around createHabit exists to prevent, so the assertions
   * below check the rollback and not only the status.
   */
  it("refuses a target on a create with no unit, and writes no version", async () => {
    await withApi(async ({ api, client }) => {
      const response = await api("/api/habits", {
        method: "POST",
        body: newHabit({ schedule: { ...FIXED_DAILY, target_value: 5 } }),
      });

      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /unit/);

      const versions = await client.query("SELECT count(*)::int AS n FROM habit_schedules");
      assert.equal(versions.rows[0].n, 0, "no orphan version may be left behind");
    });
  });

  /*
   * And the habit row goes with it — which this harness cannot show, so this
   * one steps outside it.
   *
   * withTransaction is reentrant and flattened, so inside withApi the
   * createHabit transaction joins the test's own and the throw below rolls back
   * nothing observable: the habit INSERT is still sitting in the outer
   * transaction, waiting for the rollback that ends the test. Running on the
   * pool instead gives createHabit a real BEGIN of its own, which is the thing
   * actually being asserted.
   *
   * This is the db-harness.test.js pattern — a check made outside the rollback,
   * against the pool. It commits nothing when the code is right; the finally is
   * there for when it is wrong, so a regression fails here rather than in
   * whichever file next asserts the database is empty.
   */
  it("rolls the habit back too, rather than leaving one with no schedule", async () => {
    const name = "create-rollback-probe";
    try {
      await assert.rejects(
        () =>
          createHabit({
            name,
            colorToken: "chart-1",
            startDate: today(),
            unit: null,
            schedule: { kind: "fixed", days: [1, 2, 3, 4, 5, 6, 7], targetValue: 5 },
          }),
        /unit/,
      );

      const { rows } = await query("SELECT 1 FROM habits WHERE name = $1", [name]);
      assert.equal(rows.length, 0, "a habit with no schedule version must never commit");
    } finally {
      await query("DELETE FROM habits WHERE name = $1", [name]);
    }
  });

  /*
   * A pause asks for nothing, so there is nothing for an amount to attach to.
   * The paused branch of the union simply has no target_value field, and zod
   * strips what a branch does not declare — the same way a weekly_target sent
   * on a fixed body has always been dropped. So a client posting stale form
   * state gets the pause it asked for rather than an error about a field it did
   * not mean to send, and the shape CHECK behind it can never be reached.
   *
   * Nothing is lost by the drop: the target the pause interrupted is what
   * resumes_to reports.
   */
  it("drops a target sent with a pause rather than storing one", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);

      const response = await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: { schedule_kind: "paused", target_value: 5 },
      });

      assert.equal(response.status, 201);
      assert.equal((await response.json()).schedule.target_value, null);
    });
  });
});

describe("the unit is frozen once a number has been recorded in it", () => {
  /*
   * Two kinds of number lock the unit, and for one reason: every number this
   * habit has stored is in the unit, and no row records which unit it was.
   *
   *   measured values   the obvious kind
   *   targets           history too. A version asking for 5 km is a record of
   *                     what was wanted that week; turn the unit into miles and
   *                     the past says "5 miles", which nobody ever wrote.
   *
   * Locking on values alone let exactly that through, on any quantity habit
   * that simply had not been logged yet — which is every new one.
   */
  it("allows a change while the habit has recorded no number at all", async () => {
    await withApi(async ({ api }) => {
      // A unit, no target: measuring without aiming at anything.
      const habit = await create(api, { unit: "km", schedule: FIXED_DAILY });
      // Logged, but never measured: there is no number in the old unit, so
      // there is nothing a change could re-mean.
      await logOn(api, habit, { status: "done" });

      const listed = await (await api("/api/habits")).json();
      assert.equal(listed.habits[0].unit_locked, false);

      const response = await api(`/api/habits/${habit.id}`, {
        method: "PATCH",
        body: { unit: "miles" },
      });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).habit.unit, "miles");
    });
  });

  it("refuses a change once a target exists, even with nothing logged", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);

      const listed = await (await api("/api/habits")).json();
      assert.equal(listed.habits[0].unit_locked, true, "a target is enough on its own");

      const response = await api(`/api/habits/${habit.id}`, {
        method: "PATCH",
        body: { unit: "miles" },
      });

      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /targets set in its unit/);
    });
  });

  /*
   * And the lock reads the whole history, not the version in force today.
   *
   * A habit that asked for 5 km in March and asks for nothing now has still
   * said "5 km" — March is what a unit change would rewrite. Checking only the
   * current schedule would leave every habit that dropped its target free to
   * re-mean the months behind it.
   */
  it("refuses a change for a target on an older version that today's has dropped", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { ...QUANTITY, start_date: addDays(today(), -30) });

      // Today's version asks for nothing. The one from a month ago still does.
      const dropped = await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: FIXED_DAILY,
      });
      assert.equal(dropped.status, 201);
      assert.equal((await dropped.json()).schedule.target_value, null);

      const listed = await (await api("/api/habits")).json();
      assert.equal(listed.habits[0].schedule.target_value, null, "today asks for nothing");
      assert.equal(listed.habits[0].unit_locked, true, "but a month ago did");

      const response = await api(`/api/habits/${habit.id}`, {
        method: "PATCH",
        body: { unit: "miles" },
      });

      assert.equal(response.status, 409);
    });
  });

  it("refuses a change once a value exists, and says the unit is locked", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);
      await logOn(api, habit, { status: "done", value: 5 });

      const listed = await (await api("/api/habits")).json();
      assert.equal(listed.habits[0].unit_locked, true);

      const response = await api(`/api/habits/${habit.id}`, {
        method: "PATCH",
        body: { unit: "miles" },
      });

      assert.equal(response.status, 409);
      // The reason has to match what is actually on the screen: a measured
      // habit is locked by its measurements, whatever else is also true.
      assert.match((await response.json()).error, /days measured in its unit/);
    });
  });

  it("refuses clearing the unit once a value exists", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);
      await logOn(api, habit, { status: "done", value: 5 });

      const response = await api(`/api/habits/${habit.id}`, {
        method: "PATCH",
        body: { unit: null },
      });

      assert.equal(response.status, 409);
    });
  });

  it("allows clearing the unit while nothing carries a value", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { unit: "km", schedule: FIXED_DAILY });

      const response = await api(`/api/habits/${habit.id}`, {
        method: "PATCH",
        body: { unit: null },
      });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).habit.unit, null);
    });
  });

  /*
   * The one asymmetry in the rule, and the reason for it: clearing cannot leave
   * a target behind to be re-meant, because it takes every one of them with it
   * in the same statement. Swapping km for miles would leave them all in place.
   */
  it("allows clearing the unit even when a target has locked it", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);

      const listed = await (await api("/api/habits")).json();
      assert.equal(listed.habits[0].unit_locked, true);

      const response = await api(`/api/habits/${habit.id}`, {
        method: "PATCH",
        body: { unit: null },
      });

      assert.equal(response.status, 200, "going binary is never a re-meaning");
      const cleared = (await response.json()).habit;
      assert.equal(cleared.unit, null);
      assert.equal(cleared.schedule.target_value, null);
      assert.equal(cleared.unit_locked, false, "and nothing is left holding the lock");
    });
  });

  /*
   * An absent key and an explicit null are different requests, and COALESCE
   * cannot tell them apart on a nullable column — which is why the service takes
   * a separate flag rather than reading null as silence.
   */
  it("leaves the unit alone when the patch does not mention it", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);
      await logOn(api, habit, { status: "done", value: 5 });

      const response = await api(`/api/habits/${habit.id}`, {
        method: "PATCH",
        body: { name: "Evening run" },
      });

      assert.equal(response.status, 200, "a locked unit must not block an unrelated edit");
      const updated = (await response.json()).habit;
      assert.equal(updated.name, "Evening run");
      assert.equal(updated.unit, "km");
    });
  });

  it("allows re-sending the unit it already has", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);
      await logOn(api, habit, { status: "done", value: 5 });

      const response = await api(`/api/habits/${habit.id}`, {
        method: "PATCH",
        body: { unit: "km" },
      });

      // Not a change, so not something the freeze has any reason to refuse.
      assert.equal(response.status, 200);
    });
  });

  /*
   * The one direction that is always safe: a binary habit's history holds no
   * values and no targets at all — it cannot hold a target, having no unit to
   * express one in — so adding a unit re-means nothing.
   */
  it("allows a binary habit with history to become a quantity one", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);
      await logOn(api, habit, { status: "done" });

      assert.equal(habit.unit_locked, false);

      const response = await api(`/api/habits/${habit.id}`, {
        method: "PATCH",
        body: { unit: "reps" },
      });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).habit.unit, "reps");
    });
  });
});

describe("logging a value", () => {
  it("stores a measured done day", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);
      const response = await logOn(api, habit, { status: "done", value: 3.5 });

      assert.equal(response.status, 200);
      assert.equal((await response.json()).log.value, 3.5);
    });
  });

  it("stores a done day with no value at all", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);
      const response = await logOn(api, habit, { status: "done" });

      assert.equal(response.status, 200);
      // Done, not measured. A real state, not an incomplete row.
      assert.equal((await response.json()).log.value, null);
    });
  });

  it("stores a value on a missed and on a skipped day", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);

      const missed = await logOn(api, habit, { status: "missed", value: 3 });
      assert.equal((await missed.json()).log.value, 3);

      const skipped = await logOn(
        api,
        habit,
        { status: "skipped", value: 2 },
        addDays(today(), -1),
      );
      assert.equal((await skipped.json()).log.value, 2);
    });
  });

  it("stores a zero on a missed day", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);
      const response = await logOn(api, habit, { status: "missed", value: 0 });

      // "I tried and got nowhere" — not the contradiction done + 0 is.
      assert.equal(response.status, 200);
      assert.equal((await response.json()).log.value, 0);
    });
  });

  it("refuses a done day that measured zero", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);
      const response = await logOn(api, habit, { status: "done", value: 0 });

      // 400 from the schema, never a 500 from the CHECK behind it.
      assert.equal(response.status, 400);
    });
  });

  it("refuses a value on a habit with no unit", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api);
      const response = await logOn(api, habit, { status: "done", value: 5 });

      assert.equal(response.status, 400);
    });
  });

  /*
   * numeric(10, 2) rounds on the way in, so a value below the storable precision
   * would silently become zero — and on a done row that is the one pair the
   * database refuses, which would surface as a 500 for a number the user entered
   * as positive.
   */
  it("refuses a value below the storable precision", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);
      const response = await logOn(api, habit, { status: "done", value: 0.004 });

      assert.equal(response.status, 400);
    });
  });

  it("refuses a value past the column's range with a 400, not a 500", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);
      const response = await logOn(api, habit, { status: "done", value: 1e12 });

      assert.equal(response.status, 400);
    });
  });

  /*
   * PUT replaces. An omitted value clears the old one exactly as an omitted note
   * already does — preserving it would let a status change strand a measurement
   * from a different claim, and could carry a legal missed + 0 into an illegal
   * done + 0.
   */
  it("clears the value when a later write omits it", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);
      await logOn(api, habit, { status: "done", value: 5 });

      const response = await logOn(api, habit, { status: "done" });
      assert.equal((await response.json()).log.value, null);
    });
  });
});

describe("the target is versioned", () => {
  it("adds a target to a habit that had none", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, { unit: "km", schedule: FIXED_DAILY });

      const response = await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: { ...FIXED_DAILY, target_value: 8 },
      });

      assert.equal(response.status, 201);
      assert.equal((await response.json()).schedule.target_value, 8);
    });
  });

  it("removes a target by storing a version without one", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);

      const response = await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: FIXED_DAILY,
      });

      assert.equal((await response.json()).schedule.target_value, null);
    });
  });

  /*
   * The upsert's SET list is exhaustive, not a patch. Correcting a schedule on
   * the day you set it must not leave the old target behind on a row that looks
   * freshly written — the quietest bug this change could have introduced.
   */
  it("does not leave a stale target when a same-day correction omits it", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);

      await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: { ...FIXED_DAILY, target_value: 9 },
      });

      const corrected = await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: { schedule_kind: "fixed", schedule_days: [1, 3, 5] },
      });

      assert.equal((await corrected.json()).schedule.target_value, null);

      const listed = await (await api("/api/habits")).json();
      assert.equal(listed.habits[0].schedule.target_value, null);
    });
  });

  it("refuses a backdated target change like any other", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);

      const response = await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: { ...FIXED_DAILY, target_value: 8, effective_from: addDays(today(), -1) },
      });

      assert.equal(response.status, 400);
    });
  });

  /*
   * A change of scoring unit still waits for Monday, and the target rides along
   * with the version it belongs to rather than arriving early on its own.
   */
  it("carries the target on a Monday-deferred change, reported as next_schedule", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);

      const response = await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: { schedule_kind: "weekly", weekly_target: 3, target_value: 7 },
      });

      const { schedule } = await response.json();
      assert.equal(schedule.target_value, 7);

      const listed = await (await api("/api/habits")).json();
      const row = listed.habits[0];

      if (schedule.effective_from > today()) {
        assert.equal(row.schedule.target_value, 5, "today still asks for the old target");
        assert.equal(row.next_schedule.target_value, 7);
      } else {
        // The change was asked for on a Monday, so it starts at once.
        assert.equal(row.schedule.target_value, 7);
      }
    });
  });

  it("restores the target when a paused habit resumes", async () => {
    await withApi(async ({ api }) => {
      /*
       * Started before today on purpose. A pause dated to the same day as the
       * version it replaces goes through setSchedule's upsert and genuinely
       * destroys that version — target included — so resumes_to would be null
       * and the habit would have nothing to resume to. That edge is documented
       * behaviour, not something the target changes.
       */
      const habit = await create(api, { ...QUANTITY, start_date: addDays(today(), -30) });

      await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: { schedule_kind: "paused" },
      });

      const listed = await (await api("/api/habits")).json();
      const row = listed.habits[0];

      assert.equal(row.schedule.schedule_kind, "paused");
      assert.equal(row.schedule.target_value, null, "a pause asks for nothing");
      // Without this the client would have to invent a target to resume on,
      // which is the same silent rewrite resumes_to exists to prevent.
      assert.equal(row.resumes_to.target_value, 5);
    });
  });
});

/*
 * "A target requires a unit" spans two tables, so no CHECK can hold it — the
 * migration says so explicitly and hands it to the API. insertVersion carried
 * it on the write path; clearing the unit attacked the same invariant from the
 * other side and left a binary habit with targets still on its versions.
 *
 * That state was not merely untidy. The editor reads a version's target back
 * into its draft, so the schedule became unsavable — every change sent an
 * amount the habit could no longer express, at a field it no longer showed —
 * and re-adding a different unit re-meant the orphan without anyone typing it.
 */
describe("clearing the unit clears what was being aimed at", () => {
  it("takes the target off every version, and leaves the rest of them alone", async () => {
    await withApi(async ({ api, client }) => {
      const habit = await create(api, { ...QUANTITY, start_date: addDays(today(), -30) });

      // A second version, so this proves the whole history is cleared and not
      // just the one in force. Written directly: the API refuses a backdate.
      await client.query(
        `INSERT INTO habit_schedules
           (habit_id, effective_from, schedule_kind, weekly_target, target_value)
         VALUES ($1, $2, 'weekly', 3, 8)`,
        [habit.id, addDays(today(), -10)],
      );

      const response = await api(`/api/habits/${habit.id}`, {
        method: "PATCH",
        body: { unit: null },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).habit.unit, null);

      const { rows } = await client.query(
        `SELECT effective_from, schedule_kind, schedule_days, weekly_target, target_value
           FROM habit_schedules WHERE habit_id = $1 ORDER BY effective_from`,
        [habit.id],
      );

      assert.deepEqual(
        rows.map((row) => row.target_value),
        [null, null],
        "no version may still be aiming at a number",
      );
      // Everything that is not the target is a decision the person made and
      // did not take back.
      assert.equal(rows[0].schedule_kind, "fixed");
      assert.deepEqual(rows[0].schedule_days, [1, 2, 3, 4, 5, 6, 7]);
      assert.equal(rows[1].schedule_kind, "weekly");
      assert.equal(rows[1].weekly_target, 3);
    });
  });

  it("leaves the habit behaving as a binary one", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);
      await api(`/api/habits/${habit.id}`, { method: "PATCH", body: { unit: null } });

      const listed = await (await api("/api/habits")).json();
      assert.equal(listed.habits[0].unit, null);
      assert.equal(listed.habits[0].schedule.target_value, null);

      // A binary habit has nowhere to put a number, at either end.
      const measured = await logOn(api, habit, { status: "done", value: 3 });
      assert.equal(measured.status, 400);

      // And the schedule is savable again, which the orphan target had stopped:
      // the editor sent it back to a gate that now refused it.
      const saved = await api(`/api/habits/${habit.id}/schedule`, {
        method: "POST",
        body: { schedule_kind: "fixed", schedule_days: [2, 4] },
      });
      assert.equal(saved.status, 201);
    });
  });

  it("does not hand the old target to a unit added later", async () => {
    await withApi(async ({ api }) => {
      const habit = await create(api, QUANTITY);

      await api(`/api/habits/${habit.id}`, { method: "PATCH", body: { unit: null } });
      await api(`/api/habits/${habit.id}`, { method: "PATCH", body: { unit: "miles" } });

      const listed = await (await api("/api/habits")).json();
      assert.equal(listed.habits[0].unit, "miles");
      assert.equal(
        listed.habits[0].schedule.target_value,
        null,
        "5 km must not come back as 5 miles — nobody typed that",
      );
    });
  });

  it("touches no log, and no streak or consistency that rests on one", async () => {
    await withApi(async ({ api, client }) => {
      const habit = await create(api, { ...QUANTITY, start_date: addDays(today(), -5) });
      // Unmeasured, because a measured one would lock the unit — which is the
      // only reason this path is reachable at all.
      for (const back of [1, 2, 3]) {
        await logOn(api, habit, { status: "done" }, addDays(today(), -back));
      }

      const before = await (await api(`/api/day/${addDays(today(), -1)}`)).json();
      await api(`/api/habits/${habit.id}`, { method: "PATCH", body: { unit: null } });
      const after = await (await api(`/api/day/${addDays(today(), -1)}`)).json();

      assert.equal(before.habits[0].streak, 3);
      assert.equal(after.habits[0].streak, before.habits[0].streak);
      assert.equal(after.habits[0].verdict, before.habits[0].verdict);

      const { rows } = await client.query(
        "SELECT date, status, value FROM habit_logs WHERE habit_id = $1 ORDER BY date",
        [habit.id],
      );
      assert.equal(rows.length, 3, "every logged day survives");
      assert.deepEqual(
        rows.map((row) => row.status),
        ["done", "done", "done"],
      );
    });
  });
});
