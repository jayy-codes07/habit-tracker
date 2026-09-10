/**
 * The database's own invariants.
 *
 * Every case here is an insert that must be impossible. They exist because the
 * schema — not the API — is the last line of defence: a bug in a future
 * controller, a mistyped seed, or a hand-run psql statement all pass through
 * these constraints, and none of them can write a row that contradicts the
 * product's rules.
 *
 * Each case asserts the specific constraint that rejected it, so a constraint
 * being dropped or renamed fails loudly rather than being silently covered by
 * some other rule.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { query } from "../src/db/index.js";
import {
  DEFAULT_START_DATE,
  closePool,
  makeHabit,
  makeJournal,
  makeLog,
  makeSchedule,
  makeTask,
  withRollback,
} from "./helpers/db.js";

after(closePool);

/**
 * Runs `attempt` in its own transaction and requires the database to reject it
 * with the named constraint. A separate transaction per case matters: the first
 * failed statement aborts the one it is in, so later cases would fail for the
 * wrong reason.
 */
function rejectsWith(constraint, attempt) {
  return withRollback(async () => {
    await assert.rejects(
      async () => {
        await attempt();
      },
      (error) => {
        assert.equal(
          error.constraint,
          constraint,
          `expected constraint ${constraint}, got ${error.constraint ?? "(none)"}: ${error.message}`,
        );
        return true;
      },
    );
  });
}

const LONG = (n) => "x".repeat(n);

const cases = [
  // --- habits ---
  ["a blank habit name", "habits_name_not_blank", () => makeHabit({ name: "   " })],
  ["an empty habit name", "habits_name_not_blank", () => makeHabit({ name: "" })],
  ["a habit name over 80 characters", "habits_name_not_blank", () => makeHabit({ name: LONG(81) })],
  [
    "a colour outside the theme tokens",
    "habits_color_token_valid",
    () => makeHabit({ color_token: "#ff0000" }),
  ],
  [
    "a colour token that does not exist",
    "habits_color_token_valid",
    () => makeHabit({ color_token: "chart-9" }),
  ],
  [
    "a zero target value",
    "habits_target_value_positive",
    () => insertHabitRaw({ target_value: 0 }),
  ],
  [
    "a negative target value",
    "habits_target_value_positive",
    () => insertHabitRaw({ target_value: -5 }),
  ],
  [
    "a unit with nothing to measure",
    "habits_unit_requires_target",
    () => insertHabitRaw({ unit: "pages" }),
  ],

  // --- habit_schedules ---
  [
    "an unknown schedule kind",
    "habit_schedules_kind_valid",
    async () => {
      const habit = await makeHabit({ schedule: false });
      await makeSchedule(habit.id, { schedule_kind: "monthly", schedule_days: null });
    },
  ],
  [
    "a fixed schedule with no days",
    "habit_schedules_shape",
    async () => {
      const habit = await makeHabit({ schedule: false });
      await makeSchedule(habit.id, { schedule_kind: "fixed", schedule_days: null });
    },
  ],
  [
    "a fixed schedule that also has a weekly target",
    "habit_schedules_shape",
    async () => {
      const habit = await makeHabit({ schedule: false });
      await makeSchedule(habit.id, { schedule_kind: "fixed", weekly_target: 3 });
    },
  ],
  [
    "a weekly schedule with no target",
    "habit_schedules_shape",
    async () => {
      const habit = await makeHabit({ schedule: false });
      await makeSchedule(habit.id, { schedule_kind: "weekly", weekly_target: null });
    },
  ],
  [
    "a weekly schedule that also has days",
    "habit_schedules_shape",
    async () => {
      const habit = await makeHabit({ schedule: false });
      await makeSchedule(habit.id, { schedule_kind: "weekly", schedule_days: [1, 2] });
    },
  ],
  [
    "a paused schedule with days",
    "habit_schedules_shape",
    async () => {
      const habit = await makeHabit({ schedule: false });
      await makeSchedule(habit.id, { schedule_kind: "paused", schedule_days: [1] });
    },
  ],
  [
    "a paused schedule with a weekly target",
    "habit_schedules_shape",
    async () => {
      const habit = await makeHabit({ schedule: false });
      await makeSchedule(habit.id, { schedule_kind: "paused", weekly_target: 2 });
    },
  ],
  [
    "a weekly target of zero",
    "habit_schedules_weekly_target_range",
    async () => {
      const habit = await makeHabit({ schedule: false });
      await makeSchedule(habit.id, { schedule_kind: "weekly", weekly_target: 0 });
    },
  ],
  [
    "a weekly target above seven",
    "habit_schedules_weekly_target_range",
    async () => {
      const habit = await makeHabit({ schedule: false });
      await makeSchedule(habit.id, { schedule_kind: "weekly", weekly_target: 8 });
    },
  ],
  [
    "duplicate weekdays",
    "habit_schedules_days_valid",
    async () => {
      const habit = await makeHabit({ schedule: false });
      await makeSchedule(habit.id, { schedule_days: [1, 1, 3] });
    },
  ],
  [
    "weekday zero",
    "habit_schedules_days_valid",
    async () => {
      const habit = await makeHabit({ schedule: false });
      await makeSchedule(habit.id, { schedule_days: [0, 1] });
    },
  ],
  [
    "weekday eight",
    "habit_schedules_days_valid",
    async () => {
      const habit = await makeHabit({ schedule: false });
      await makeSchedule(habit.id, { schedule_days: [8] });
    },
  ],
  [
    "an empty weekday array",
    "habit_schedules_days_valid",
    async () => {
      const habit = await makeHabit({ schedule: false });
      await makeSchedule(habit.id, { schedule_days: [] });
    },
  ],
  [
    "two schedule versions starting the same day",
    "habit_schedules_unique_start",
    async () => {
      const habit = await makeHabit(); // already has one at start_date
      await makeSchedule(habit.id, { effective_from: habit.start_date });
    },
  ],

  // --- habit_logs ---
  [
    "an unknown log status",
    "habit_logs_status_valid",
    async () => {
      const habit = await makeHabit();
      await makeLog(habit.id, { status: "partial" });
    },
  ],
  [
    "the old boolean spelling of a status",
    "habit_logs_status_valid",
    async () => {
      const habit = await makeHabit();
      await makeLog(habit.id, { status: "true" });
    },
  ],
  [
    "two logs for one habit on one day",
    "habit_logs_unique_day",
    async () => {
      const habit = await makeHabit();
      await makeLog(habit.id, { date: DEFAULT_START_DATE });
      await makeLog(habit.id, { date: DEFAULT_START_DATE });
    },
  ],
  [
    "a negative log value",
    "habit_logs_value_non_negative",
    async () => {
      const habit = await makeHabit();
      await makeLog(habit.id, { value: -1 });
    },
  ],
  [
    "a note over 1000 characters",
    "habit_logs_note_length",
    async () => {
      const habit = await makeHabit();
      await makeLog(habit.id, { note: LONG(1001) });
    },
  ],

  // --- tasks ---
  ["a blank task title", "tasks_title_not_blank", () => makeTask({ title: "  " })],
  [
    "a task title over 200 characters",
    "tasks_title_not_blank",
    () => makeTask({ title: LONG(201) }),
  ],
  [
    "a completed task with no completion time",
    "tasks_completed_consistent",
    () => makeTask({ completed: true, completed_at: null }),
  ],
  [
    "an open task that has a completion time",
    "tasks_completed_consistent",
    () => makeTask({ completed: false, completed_at: new Date().toISOString() }),
  ],

  // --- journal ---
  ["an unknown journal kind", "journal_kind_valid", () => makeJournal({ kind: "week" })],
  ["a blank journal entry", "journal_entry_not_blank", () => makeJournal({ entry: "   " })],
  [
    "a monthly reflection not on the 1st",
    "journal_month_anchored",
    () => makeJournal({ kind: "month", date: "2026-03-14" }),
  ],
  [
    "two entries of one kind on one day",
    "journal_unique_entry",
    async () => {
      await makeJournal({ date: "2026-03-02", kind: "day" });
      await makeJournal({ date: "2026-03-02", kind: "day" });
    },
  ],
];

/** Bypasses makeHabit for columns it does not expose. */
async function insertHabitRaw(overrides) {
  const row = {
    name: "Raw habit",
    color_token: "chart-1",
    sort_order: 0,
    start_date: DEFAULT_START_DATE,
    target_value: null,
    unit: null,
    ...overrides,
  };
  await query(
    `INSERT INTO habits (name, color_token, sort_order, start_date, target_value, unit)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [row.name, row.color_token, row.sort_order, row.start_date, row.target_value, row.unit],
  );
}

describe("schema invariants", () => {
  for (const [description, constraint, attempt] of cases) {
    it(`rejects ${description}`, () => rejectsWith(constraint, attempt));
  }

  it("covers every case the product depends on", () => {
    // A tripwire, not a metric: if a constraint is added to the schema without a
    // case here, this number is the reminder.
    assert.equal(cases.length, 35);
  });
});

describe("things the schema must allow", () => {
  it("accepts all three schedule kinds", async () => {
    await withRollback(async () => {
      const habit = await makeHabit({ schedule: false });
      await makeSchedule(habit.id, { effective_from: "2026-01-05", schedule_kind: "fixed" });
      await makeSchedule(habit.id, { effective_from: "2026-02-02", schedule_kind: "paused" });
      await makeSchedule(habit.id, { effective_from: "2026-02-09", schedule_kind: "weekly" });

      const { rows } = await query(
        "SELECT schedule_kind FROM habit_schedules WHERE habit_id = $1 ORDER BY effective_from",
        [habit.id],
      );
      assert.deepEqual(
        rows.map((r) => r.schedule_kind),
        ["fixed", "paused", "weekly"],
      );
    });
  });

  it("accepts all three log statuses", async () => {
    await withRollback(async () => {
      const habit = await makeHabit();
      await makeLog(habit.id, { date: "2026-01-05", status: "done" });
      await makeLog(habit.id, { date: "2026-01-06", status: "missed" });
      await makeLog(habit.id, { date: "2026-01-07", status: "skipped" });

      const { rows } = await query(
        "SELECT status FROM habit_logs WHERE habit_id = $1 ORDER BY date",
        [habit.id],
      );
      assert.deepEqual(
        rows.map((r) => r.status),
        ["done", "missed", "skipped"],
      );
    });
  });

  it("keeps the same day free for a different habit", async () => {
    await withRollback(async () => {
      const one = await makeHabit();
      const two = await makeHabit();
      await makeLog(one.id, { date: DEFAULT_START_DATE });
      await makeLog(two.id, { date: DEFAULT_START_DATE });
    });
  });

  it("deletes a habit's schedules and logs with it", async () => {
    await withRollback(async () => {
      const habit = await makeHabit();
      await makeLog(habit.id);

      await query("DELETE FROM habits WHERE id = $1", [habit.id]);

      const { rows } = await query(
        `SELECT (SELECT count(*)::int FROM habit_schedules WHERE habit_id = $1) AS schedules,
                (SELECT count(*)::int FROM habit_logs      WHERE habit_id = $1) AS logs`,
        [habit.id],
      );
      assert.deepEqual(rows[0], { schedules: 0, logs: 0 });
    });
  });
});
