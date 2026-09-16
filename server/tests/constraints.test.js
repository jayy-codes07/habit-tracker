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
  makeProblem,
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
  ["a blank unit", "habits_unit_valid", () => makeHabit({ unit: "   " })],
  ["a unit over 20 characters", "habits_unit_valid", () => makeHabit({ unit: LONG(21) })],

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
  // A pause asks for nothing, and an amount is something.
  [
    "a paused schedule that still asks for an amount",
    "habit_schedules_shape",
    async () => {
      const habit = await makeHabit({ schedule: false, unit: "km" });
      await makeSchedule(habit.id, { schedule_kind: "paused", target_value: 5 });
    },
  ],
  [
    "a zero target value",
    "habit_schedules_target_value_positive",
    async () => {
      const habit = await makeHabit({ schedule: false, unit: "km" });
      await makeSchedule(habit.id, { target_value: 0 });
    },
  ],
  [
    "a negative target value",
    "habit_schedules_target_value_positive",
    async () => {
      const habit = await makeHabit({ schedule: false, unit: "km" });
      await makeSchedule(habit.id, { target_value: -5 });
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
  // The one (status, value) pair with no reading: "I consider this done, and I
  // did zero". missed + 0 and skipped + 0 stay legal — see the allowed cases.
  [
    "a done log that measured zero",
    "habit_logs_done_value_not_zero",
    async () => {
      const habit = await makeHabit({ unit: "km" });
      await makeLog(habit.id, { status: "done", value: 0 });
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

  // --- leetcode_problems ---
  ["a blank problem title", "leetcode_problems_title_not_blank", () => makeProblem({ title: " " })],
  [
    "a problem title over 200 characters",
    "leetcode_problems_title_not_blank",
    () => makeProblem({ title: LONG(201) }),
  ],
  [
    "a difficulty outside the three",
    "leetcode_problems_difficulty_valid",
    () => makeProblem({ difficulty: "expert" }),
  ],
  ["problem number zero", "leetcode_problems_number_positive", () => makeProblem({ number: 0 })],
  [
    "more than eight topics",
    "leetcode_problems_topics_valid",
    () => makeProblem({ topics: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }),
  ],
  [
    "a blank topic",
    "leetcode_problems_topics_valid",
    () => makeProblem({ topics: ["graph", "  "] }),
  ],
  [
    "the same topic twice",
    "leetcode_problems_topics_valid",
    () => makeProblem({ topics: ["dp", "dp"] }),
  ],
  [
    "a topic over 30 characters",
    "leetcode_problems_topics_valid",
    () => makeProblem({ topics: [LONG(31)] }),
  ],
  // The one constraint here that is a security control rather than a tidiness
  // rule: this column is rendered into an href.
  [
    "a javascript: problem URL",
    "leetcode_problems_url_absolute",
    () => makeProblem({ url: "javascript:alert(1)" }),
  ],
  [
    "a relative problem URL",
    "leetcode_problems_url_absolute",
    () => makeProblem({ url: "/problems/two-sum/" }),
  ],
  [
    "an approach over 20000 characters",
    "leetcode_problems_approach_length",
    () => makeProblem({ approach: LONG(20001) }),
  ],
  [
    "a solution over 40000 characters",
    "leetcode_problems_solution_length",
    () => makeProblem({ solution: LONG(40001) }),
  ],
  [
    "a screenshot type with no bytes behind it",
    "leetcode_problems_screenshot_whole",
    () => makeProblem({ screenshot_type: "image/png" }),
  ],
  [
    "screenshot bytes with no type to serve them as",
    "leetcode_problems_screenshot_whole",
    () => makeProblem({ screenshot: Buffer.from([1, 2, 3]), screenshot_bytes: 3 }),
  ],
  // SVG is script-capable and this app serves the bytes back from its own
  // origin, so the allowlist is the thing standing between a stored file and
  // stored XSS.
  [
    "an SVG screenshot",
    "leetcode_problems_screenshot_type_valid",
    () =>
      makeProblem({
        screenshot: Buffer.from("<svg/>"),
        screenshot_type: "image/svg+xml",
        screenshot_bytes: 6,
      }),
  ],
];

// insertHabitRaw used to live here, to reach habits.target_value and habits.unit
// which makeHabit did not expose. Both are reachable now: the target moved to
// habit_schedules and makeSchedule takes it, and makeHabit takes the unit —
// because the unit is what makes a habit quantity-based, so no fixture can
// describe one without it.

describe("schema invariants", () => {
  for (const [description, constraint, attempt] of cases) {
    it(`rejects ${description}`, () => rejectsWith(constraint, attempt));
  }

  it("covers every case the product depends on", () => {
    // A tripwire, not a metric: if a constraint is added to the schema without a
    // case here, this number is the reminder.
    assert.equal(cases.length, 53);
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

  /*
   * The positive half of the quantity model, and the half most likely to be
   * over-constrained by accident. Every row here is legal, and each says
   * something different:
   *
   *   a fixed version with no target   a quantity habit may measure without
   *                                    aiming, so the target is optional on
   *                                    every kind that can hold one at all
   *   done with no value               done, not measured — a first-class
   *                                    state, not an incomplete row
   *   missed with a value              an honest partial attempt
   *   skipped with a value             a rest day worked anyway
   *   missed with zero                 "I tried and got nowhere", which is not
   *                                    the contradiction done + 0 is
   */
  it("accepts a quantity schedule with no target", async () => {
    await withRollback(async () => {
      const habit = await makeHabit({ schedule: false, unit: "km" });
      await makeSchedule(habit.id, { target_value: null });

      const { rows } = await query("SELECT target_value FROM habit_schedules WHERE habit_id = $1", [
        habit.id,
      ]);
      assert.equal(rows[0].target_value, null);
    });
  });

  it("accepts every log value the model calls meaningful", async () => {
    await withRollback(async () => {
      const habit = await makeHabit({ unit: "km" });
      await makeLog(habit.id, { date: "2026-01-05", status: "done", value: null });
      await makeLog(habit.id, { date: "2026-01-06", status: "done", value: 3.5 });
      await makeLog(habit.id, { date: "2026-01-07", status: "missed", value: 3 });
      await makeLog(habit.id, { date: "2026-01-08", status: "skipped", value: 2 });
      await makeLog(habit.id, { date: "2026-01-09", status: "missed", value: 0 });

      const { rows } = await query(
        "SELECT value::float8 AS value FROM habit_logs WHERE habit_id = $1 ORDER BY date",
        [habit.id],
      );
      assert.deepEqual(
        rows.map((r) => r.value),
        [null, 3.5, 3, 2, 0],
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
