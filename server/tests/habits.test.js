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

import { addDays, today } from "../src/lib/dates.js";
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
