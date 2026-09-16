/**
 * Quantity attainment, as pure arithmetic.
 *
 * No database and no fixtures, for the same reason the streak tests have none:
 * the interesting cases here are combinations of (status, value, target), and
 * there are more of them than anyone would write HTTP tests for.
 *
 * The load-bearing test in this file is the last one. Attainment must not be
 * able to move a streak or a consistency rate, and the way that is guaranteed is
 * that lib/streaks.js never reads a value at all — so a quantity habit and a
 * binary habit with the same statuses have to score identically.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { attainment } from "../src/lib/attainment.js";
import { consistency, currentStreak, longestStreak } from "../src/lib/streaks.js";

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

/** A quantity habit whose whole history is one fixed, every-day version. */
function habitOf({ logs = {}, values = {}, versions = null, startDate = "2026-01-05", ...rest }) {
  return {
    startDate,
    archivedOn: null,
    through: null,
    versions: versions ?? [
      {
        effective_from: startDate,
        schedule_kind: "fixed",
        schedule_days: EVERY_DAY,
        weekly_target: null,
        target_value: 5,
      },
    ],
    logs: new Map(Object.entries(logs)),
    values: new Map(Object.entries(values)),
    ...rest,
  };
}

const over = (window) => ({ from: "2026-01-05", to: "2026-01-11", ...window });

/**
 * Rates are ordinary floating-point division and are reported unrounded, the
 * same way consistency() reports its own: three sessions at 0.2 sum to
 * 0.6000000000000001 and divide to 0.20000000000000004. Rounding inside the
 * calculation would be a behaviour nobody asked for and would make attainment
 * disagree with the rate beside it, so the tolerance lives here instead.
 */
function assertRate(actual, { sessions, rate }) {
  assert.equal(actual.sessions, sessions);
  if (rate === null) assert.equal(actual.rate, null);
  else assert.ok(Math.abs(actual.rate - rate) < 1e-9, `expected ~${rate}, got ${actual.rate}`);
}

describe("attainment: which sessions count", () => {
  it("averages the measured done days against the day's target", () => {
    const habit = habitOf({
      logs: { "2026-01-05": "done", "2026-01-06": "done" },
      values: { "2026-01-05": 5, "2026-01-06": 3 },
    });

    // (1 + 0.6) / 2
    assertRate(attainment(habit, over()), { sessions: 2, rate: 0.8 });
  });

  /*
   * "Done, did not measure" is a first-class state. It is not a sample, so it
   * leaves both halves of the ratio: scoring it 0 would punish not typing a
   * number, and dropping it into the numerator as 1 would make a habit look
   * perfect for the months nobody measured it.
   */
  it("ignores a done day with no value, rather than scoring it either way", () => {
    const habit = habitOf({
      logs: { "2026-01-05": "done", "2026-01-06": "done" },
      values: { "2026-01-05": 3 },
    });

    assertRate(attainment(habit, over()), { sessions: 1, rate: 0.6 });
  });

  /** The user's claim decides, so a measured miss is a record and not a score. */
  it("ignores a missed day even when it carries a value", () => {
    const habit = habitOf({
      logs: { "2026-01-05": "done", "2026-01-06": "missed" },
      values: { "2026-01-05": 5, "2026-01-06": 4.9 },
    });

    assertRate(attainment(habit, over()), { sessions: 1, rate: 1 });
  });

  it("ignores a skipped day even when it carries a value", () => {
    const habit = habitOf({
      logs: { "2026-01-05": "done", "2026-01-06": "skipped" },
      values: { "2026-01-05": 3, "2026-01-06": 5 },
    });

    assertRate(attainment(habit, over()), { sessions: 1, rate: 0.6 });
  });

  /*
   * status === 'done', not verdict === DONE. A measured session worked on a day
   * nothing was asked for reports `bonus`, and reading the verdict would make it
   * invisible for the sole reason that it was extra. Every measured session
   * counts — there are no bonus occurrences here.
   */
  it("counts a measured session worked on an unscheduled day", () => {
    const habit = habitOf({
      versions: [
        {
          effective_from: "2026-01-05",
          schedule_kind: "fixed",
          schedule_days: [1], // Mondays only; the 6th is a Tuesday
          weekly_target: null,
          target_value: 5,
        },
      ],
      logs: { "2026-01-05": "done", "2026-01-06": "done" },
      values: { "2026-01-05": 5, "2026-01-06": 2 },
    });

    assertRate(attainment(habit, over()), { sessions: 2, rate: 0.7 });
  });

  it("caps a session that went past the target at 1", () => {
    const habit = habitOf({
      logs: { "2026-01-05": "done", "2026-01-06": "done" },
      values: { "2026-01-05": 50, "2026-01-06": 1 },
    });

    // Without the cap this would be (10 + 0.2) / 2 — one big day carrying a
    // month of small ones, which is the overshoot-hides-shortfall failure.
    assertRate(attainment(habit, over()), { sessions: 2, rate: 0.6 });
  });

  it("reports null, not zero, when nothing was measured", () => {
    const habit = habitOf({ logs: { "2026-01-05": "done" } });
    assertRate(attainment(habit, over()), { sessions: 0, rate: null });
  });

  it("reports null for a binary habit, which has no target to measure against", () => {
    const habit = habitOf({
      versions: [
        {
          effective_from: "2026-01-05",
          schedule_kind: "fixed",
          schedule_days: EVERY_DAY,
          weekly_target: null,
          target_value: null,
        },
      ],
      logs: { "2026-01-05": "done" },
    });

    assertRate(attainment(habit, over()), { sessions: 0, rate: null });
  });
});

describe("attainment: which target", () => {
  /*
   * The reason the target lives on the schedule version. A day lived under a
   * 5 km target keeps being scored against 5 after the target becomes 10 —
   * raising your sights must not retroactively turn a good week into a bad one.
   */
  it("scores each day against the target in force on that day", () => {
    const habit = habitOf({
      versions: [
        {
          effective_from: "2026-01-05",
          schedule_kind: "fixed",
          schedule_days: EVERY_DAY,
          weekly_target: null,
          target_value: 5,
        },
        {
          effective_from: "2026-01-07",
          schedule_kind: "fixed",
          schedule_days: EVERY_DAY,
          weekly_target: null,
          target_value: 10,
        },
      ],
      logs: { "2026-01-06": "done", "2026-01-08": "done" },
      values: { "2026-01-06": 5, "2026-01-08": 5 },
    });

    // The same five: a full session under the old target, a half one under the new.
    assertRate(attainment(habit, over()), { sessions: 2, rate: 0.75 });
  });

  /** A pause asks for nothing, so a day worked during one has nothing to fall short of. */
  it("ignores a measured day that falls inside a pause", () => {
    const habit = habitOf({
      versions: [
        {
          effective_from: "2026-01-05",
          schedule_kind: "fixed",
          schedule_days: EVERY_DAY,
          weekly_target: null,
          target_value: 5,
        },
        {
          effective_from: "2026-01-07",
          schedule_kind: "paused",
          schedule_days: null,
          weekly_target: null,
          target_value: null,
        },
      ],
      logs: { "2026-01-06": "done", "2026-01-08": "done" },
      values: { "2026-01-06": 3, "2026-01-08": 5 },
    });

    assertRate(attainment(habit, over()), { sessions: 1, rate: 0.6 });
  });

  it("ignores a day before the habit started", () => {
    const habit = habitOf({
      startDate: "2026-01-07",
      logs: { "2026-01-05": "done", "2026-01-08": "done" },
      values: { "2026-01-05": 5, "2026-01-08": 2.5 },
    });

    assertRate(attainment(habit, over()), { sessions: 1, rate: 0.5 });
  });

  it("stops at the day the habit was archived", () => {
    const habit = habitOf({
      archivedOn: "2026-01-06",
      logs: { "2026-01-06": "done", "2026-01-08": "done" },
      values: { "2026-01-06": 5, "2026-01-08": 1 },
    });

    assertRate(attainment(habit, over()), { sessions: 1, rate: 1 });
  });

  /*
   * A weekly habit resolves its per-occasion target per day, exactly as a fixed
   * one does. Only weekly_target — the count of occasions — uses the week's
   * opening version, because a week is one scoring period and its commitment
   * must not move inside it. An amount asked of a single session is not a
   * period commitment and needs no such rule.
   */
  it("resolves a weekly habit's target per day, not per week", () => {
    const habit = habitOf({
      versions: [
        {
          effective_from: "2026-01-05",
          schedule_kind: "weekly",
          schedule_days: null,
          weekly_target: 3,
          target_value: 5,
        },
        {
          effective_from: "2026-01-07",
          schedule_kind: "weekly",
          schedule_days: null,
          weekly_target: 3,
          target_value: 10,
        },
      ],
      logs: { "2026-01-06": "done", "2026-01-08": "done" },
      values: { "2026-01-06": 5, "2026-01-08": 5 },
    });

    assertRate(attainment(habit, over()), { sessions: 2, rate: 0.75 });
  });
});

describe("attainment cannot reach the streak or the consistency rate", () => {
  /*
   * The whole architectural claim in one assertion. lib/streaks.js reads
   * Map<date, status> and nothing else; values live in a sibling map that only
   * lib/attainment.js looks at. So a quantity habit that fell well short every
   * single day scores exactly as a binary habit that did the same days.
   */
  it("scores a quantity habit and a binary habit identically", () => {
    const logs = {
      "2026-01-05": "done",
      "2026-01-06": "done",
      "2026-01-07": "done",
      "2026-01-08": "missed",
    };

    const quantity = habitOf({
      logs,
      values: { "2026-01-05": 1, "2026-01-06": 1, "2026-01-07": 1 },
    });
    const binary = habitOf({
      logs,
      versions: [
        {
          effective_from: "2026-01-05",
          schedule_kind: "fixed",
          schedule_days: EVERY_DAY,
          weekly_target: null,
          target_value: null,
        },
      ],
    });

    const today = "2026-01-12";
    const window = { from: "2026-01-05", to: "2026-01-11", today };

    assert.equal(currentStreak(quantity, today), currentStreak(binary, today));
    assert.equal(longestStreak(quantity, today), longestStreak(binary, today));
    assert.deepEqual(consistency(quantity, window), consistency(binary, window));

    // ...while attainment sees exactly what the streaks cannot.
    assertRate(attainment(quantity, over()), { sessions: 3, rate: 0.2 });
    assertRate(attainment(binary, over()), { sessions: 0, rate: null });
  });
});
