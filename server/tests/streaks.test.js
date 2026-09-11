/**
 * Streak and consistency arithmetic.
 *
 * Pure functions over in-memory rows, so this file carries the bulk of the
 * edge-case coverage for Step 4 without a database, fixtures or a server.
 *
 * The cases that matter most are the ones where a naive implementation is wrong
 * in a way nothing reports: an unticked habit at 9am reading as a broken streak,
 * a pause counting as failure, or a schedule edit silently destroying months of
 * history.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addDays } from "../src/lib/dates.js";
import {
  consistency,
  currentStreak,
  effectiveKind,
  fixedStreak,
  longestStreak,
  scoreWeek,
  weeklyStreak,
} from "../src/lib/streaks.js";

const MONDAY = "2026-01-05";
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

const fixed = (effective_from, schedule_days = EVERY_DAY) => ({
  effective_from,
  schedule_kind: "fixed",
  schedule_days,
  weekly_target: null,
});

const weekly = (effective_from, weekly_target) => ({
  effective_from,
  schedule_kind: "weekly",
  schedule_days: null,
  weekly_target,
});

const paused = (effective_from) => ({
  effective_from,
  schedule_kind: "paused",
  schedule_days: null,
  weekly_target: null,
});

/**
 * Builds the habit view the streak functions take. `logs` is given as a plain
 * object so a test reads as a calendar.
 */
function habit({ startDate = MONDAY, archivedOn = null, versions = [fixed(MONDAY)], logs = {} }) {
  return { startDate, archivedOn, versions, logs: new Map(Object.entries(logs)) };
}

/** Marks a run of consecutive days with one status. */
function run(from, days, status) {
  const out = {};
  for (let offset = 0; offset < days; offset += 1) out[addDays(from, offset)] = status;
  return out;
}

describe("fixed streaks", () => {
  it("counts consecutive done days", () => {
    const h = habit({ logs: run(MONDAY, 5, "done") });
    assert.equal(fixedStreak(h, "2026-01-09"), 5);
  });

  it("stops at an explicit miss", () => {
    const h = habit({
      logs: { ...run(MONDAY, 5, "done"), "2026-01-07": "missed" },
    });
    // Jan 8 and 9 are done; Jan 7 is the miss.
    assert.equal(fixedStreak(h, "2026-01-09"), 2);
  });

  /** A day nobody ever logged is still a day the habit was not done. */
  it("stops at a past scheduled day with no row at all", () => {
    const logs = run(MONDAY, 5, "done");
    delete logs["2026-01-07"];
    assert.equal(fixedStreak(habit({ logs }), "2026-01-09"), 2);
  });

  /**
   * The single most important case. A habit unticked at 9am must not read as
   * broken, or the app punishes you for opening it early.
   */
  it("does not break on today while today is still unlogged", () => {
    const h = habit({ logs: run(MONDAY, 4, "done") }); // Jan 5-8 done
    assert.equal(fixedStreak(h, "2026-01-09"), 4, "today unlogged");
    assert.equal(fixedStreak(h, "2026-01-08"), 4, "today done");
  });

  it("does break on today when today was explicitly missed", () => {
    const h = habit({
      logs: { ...run(MONDAY, 4, "done"), "2026-01-09": "missed" },
    });
    assert.equal(fixedStreak(h, "2026-01-09"), 0);
  });

  /** Skipped is the whole reason a rest day does not cost you the streak. */
  it("passes through a skipped day without counting it", () => {
    const h = habit({
      logs: { ...run(MONDAY, 5, "done"), "2026-01-07": "skipped" },
    });
    assert.equal(fixedStreak(h, "2026-01-09"), 4);
  });

  it("passes through unscheduled weekdays", () => {
    // Mon/Wed/Fri only, all three done; the gaps must not break it.
    const h = habit({
      versions: [fixed(MONDAY, [1, 3, 5])],
      logs: { "2026-01-05": "done", "2026-01-07": "done", "2026-01-09": "done" },
    });
    assert.equal(fixedStreak(h, "2026-01-09"), 3);
  });

  it("stops at the habit's start date rather than running off the end", () => {
    const h = habit({ logs: run(MONDAY, 3, "done") });
    assert.equal(fixedStreak(h, "2026-01-07"), 3);
  });

  it("keeps an archived habit's streak instead of decaying to zero", () => {
    const h = habit({ archivedOn: "2026-01-09", logs: run(MONDAY, 5, "done") });
    assert.equal(fixedStreak(h, "2026-02-01"), 5);
  });

  describe("across a pause", () => {
    // Daily; paused Jan 12-18; daily again from Jan 19.
    const versions = [fixed(MONDAY), paused("2026-01-12"), fixed("2026-01-19")];

    it("passes straight through the paused span", () => {
      const h = habit({
        versions,
        logs: { ...run(MONDAY, 7, "done"), ...run("2026-01-19", 3, "done") },
      });
      // 3 after the pause + 7 before it; the pause itself contributes nothing.
      assert.equal(fixedStreak(h, "2026-01-21"), 10);
    });

    it("does not require the paused days to have been logged", () => {
      const h = habit({ versions, logs: run("2026-01-19", 2, "done") });
      assert.equal(fixedStreak(h, "2026-01-20"), 2);
    });
  });
});

describe("weekly weeks", () => {
  const target3 = [weekly(MONDAY, 3)];

  it("is met once the target is reached, whichever days were used", () => {
    const h = habit({
      versions: target3,
      logs: { "2026-01-06": "done", "2026-01-08": "done", "2026-01-10": "done" },
    });
    const week = scoreWeek(h, MONDAY, "2026-01-19");
    assert.equal(week.met, true);
    assert.equal(week.done, 3);
    assert.equal(week.target, 3);
    assert.equal(week.fullyLived, true);
  });

  it("fails a finished week that fell short", () => {
    const h = habit({ versions: target3, logs: { "2026-01-06": "done" } });
    const week = scoreWeek(h, MONDAY, "2026-01-19");
    assert.equal(week.met, false);
    assert.equal(week.fullyLived, true);
  });

  /** The current week is provisional: not yet met is not the same as failed. */
  it("treats the current week as provisional", () => {
    const h = habit({ versions: target3, logs: { "2026-01-06": "done" } });
    const week = scoreWeek(h, MONDAY, "2026-01-08");
    assert.equal(week.met, false);
    assert.equal(week.fullyLived, false);
  });

  it("counts a current week that already hit its target", () => {
    const h = habit({
      versions: target3,
      logs: { "2026-01-05": "done", "2026-01-06": "done", "2026-01-07": "done" },
    });
    const week = scoreWeek(h, MONDAY, "2026-01-08");
    assert.equal(week.met, true);
  });

  /**
   * Case A. The commitment for a week is set when the week begins, so a target
   * changed on Thursday governs the following week — immune to being raised on
   * Saturday to punish, or lowered on Sunday to rescue.
   */
  it("scores a mid-week target change with the target the week began under", () => {
    const versions = [weekly(MONDAY, 3), weekly("2026-01-08", 2)]; // Thursday
    const h = habit({
      versions,
      logs: { "2026-01-05": "done", "2026-01-06": "done" },
    });

    const week = scoreWeek(h, MONDAY, "2026-01-19");
    assert.equal(week.target, 3, "the week began under target 3");
    assert.equal(week.met, false, "2 of 3 is not met");

    // And the new target governs the next week.
    assert.equal(scoreWeek(h, "2026-01-12", "2026-01-19").target, 2);
  });

  /**
   * Case B. A pause starting mid-week can never fail the week — that is what
   * pause is for — but a week already completed before the pause still counts.
   */
  describe("when a pause begins mid-week", () => {
    const versions = [weekly(MONDAY, 3), paused("2026-01-08")]; // paused from Thursday

    it("counts the week when the target was already met", () => {
      const h = habit({
        versions,
        logs: { "2026-01-05": "done", "2026-01-06": "done", "2026-01-07": "done" },
      });
      const week = scoreWeek(h, MONDAY, "2026-01-19");
      assert.equal(week.met, true);
      assert.equal(week.fullyLived, false, "a paused week is never fully lived");
    });

    it("leaves the week neutral when it was not", () => {
      const h = habit({ versions, logs: { "2026-01-05": "done" } });
      const week = scoreWeek(h, MONDAY, "2026-01-19");
      assert.equal(week.met, false);
      assert.equal(week.fullyLived, false, "so it cannot fail");
    });
  });

  /**
   * Case C. The week is scored by the first active day that was not paused, so
   * a pause ending on Thursday does not throw away Thursday to Sunday.
   */
  describe("when a pause ends mid-week", () => {
    const versions = [paused(MONDAY), weekly("2026-01-08", 2)]; // active from Thursday

    it("scores the resumed portion rather than reading the week as paused", () => {
      const h = habit({
        versions,
        logs: { "2026-01-08": "done", "2026-01-09": "done" },
      });
      const week = scoreWeek(h, MONDAY, "2026-01-19");
      assert.equal(week.scored, true);
      assert.equal(week.target, 2);
      assert.equal(week.met, true);
    });

    it("counts days worked during the pause too", () => {
      const h = habit({
        versions,
        logs: { "2026-01-06": "done", "2026-01-08": "done" },
      });
      const week = scoreWeek(h, MONDAY, "2026-01-19");
      assert.equal(week.done, 2, "the Tuesday done during the pause still counts");
      assert.equal(week.met, true);
    });
  });

  it("is unscored when the whole week was paused", () => {
    const h = habit({ versions: [paused(MONDAY)] });
    const week = scoreWeek(h, MONDAY, "2026-01-19");
    assert.equal(week.active, true);
    assert.equal(week.scored, false);
  });

  it("is inactive for a week entirely before the habit existed", () => {
    const h = habit({ startDate: "2026-01-12", versions: [weekly("2026-01-12", 3)] });
    assert.equal(scoreWeek(h, MONDAY, "2026-01-19").active, false);
  });

  /** A week straddling the start date is an incomplete unit, like the current one. */
  it("treats a week straddling the start date as provisional", () => {
    const h = habit({
      startDate: "2026-01-07", // Wednesday
      versions: [weekly("2026-01-07", 3)],
      logs: { "2026-01-07": "done" },
    });
    const week = scoreWeek(h, MONDAY, "2026-01-19");
    assert.equal(week.active, true);
    assert.equal(week.fullyLived, false);
    assert.equal(week.met, false, "and so it cannot fail");
  });

  /** Skipped has no meaning for a weekly target: seven days already carry slack. */
  it("ignores skipped days entirely", () => {
    const h = habit({
      versions: target3,
      logs: { "2026-01-05": "done", "2026-01-06": "skipped", "2026-01-07": "done" },
    });
    const week = scoreWeek(h, MONDAY, "2026-01-19");
    assert.equal(week.target, 3, "the target is not reduced");
    assert.equal(week.done, 2);
    assert.equal(week.met, false);
  });
});

describe("weekly streaks", () => {
  const target2 = [weekly(MONDAY, 2)];

  it("counts consecutive weeks meeting target", () => {
    const h = habit({
      versions: target2,
      logs: {
        "2026-01-05": "done",
        "2026-01-06": "done", // week 1: 2 of 2
        "2026-01-12": "done",
        "2026-01-13": "done", // week 2: 2 of 2
        "2026-01-19": "done",
        "2026-01-20": "done", // week 3: 2 of 2
      },
    });
    assert.equal(weeklyStreak(h, "2026-01-26"), 3);
  });

  it("breaks at a finished week that fell short", () => {
    const h = habit({
      versions: target2,
      logs: {
        "2026-01-05": "done",
        "2026-01-06": "done", // week 1: met
        "2026-01-12": "done", // week 2: 1 of 2, failed
        "2026-01-19": "done",
        "2026-01-20": "done", // week 3: met
      },
    });
    assert.equal(weeklyStreak(h, "2026-01-26"), 1);
  });

  it("never lets the current week break the streak", () => {
    const h = habit({
      versions: target2,
      logs: { "2026-01-05": "done", "2026-01-06": "done" },
    });
    // Tuesday of the following week, nothing logged yet.
    assert.equal(weeklyStreak(h, "2026-01-13"), 1);
  });

  it("passes through a fully paused week", () => {
    const versions = [weekly(MONDAY, 2), paused("2026-01-12"), weekly("2026-01-19", 2)];
    const h = habit({
      versions,
      logs: {
        "2026-01-05": "done",
        "2026-01-06": "done", // week 1: met
        "2026-01-19": "done",
        "2026-01-20": "done", // week 3: met
      },
    });
    assert.equal(weeklyStreak(h, "2026-01-26"), 2, "the paused week is neutral");
  });
});

/**
 * Case E. Scoring stops being expressed in the old unit, but the streak itself
 * survives: losing six months of history as a side effect of editing a schedule
 * is the worst thing this app could do.
 */
describe("across a change of schedule kind", () => {
  it("keeps counting weeks back through a fixed era", () => {
    // Daily and fully done for three weeks, then weekly-2 from Jan 26.
    const versions = [fixed(MONDAY), weekly("2026-01-26", 2)];
    const h = habit({
      versions,
      logs: { ...run(MONDAY, 21, "done"), "2026-01-26": "done", "2026-01-27": "done" },
    });

    assert.equal(effectiveKind(h, "2026-02-01"), "weekly");
    // Week of Jan 26 met, plus the three fixed weeks with no failures in them.
    assert.equal(weeklyStreak(h, "2026-02-01"), 4);
  });

  it("breaks in the fixed era only where a day was actually failed", () => {
    const logs = { ...run(MONDAY, 21, "done"), "2026-01-26": "done", "2026-01-27": "done" };
    logs["2026-01-14"] = "missed"; // mid week 2
    const h = habit({ versions: [fixed(MONDAY), weekly("2026-01-26", 2)], logs });

    // Week of Jan 26 and week of Jan 19 survive; week of Jan 12 failed.
    assert.equal(weeklyStreak(h, "2026-02-01"), 2);
  });

  it("keeps counting days back through a weekly era", () => {
    // Weekly for two weeks, then fixed daily from Jan 19.
    const versions = [weekly(MONDAY, 2), fixed("2026-01-19")];
    const h = habit({ versions, logs: run("2026-01-19", 3, "done") });

    assert.equal(effectiveKind(h, "2026-01-21"), "fixed");
    // The weekly era names no specific days, so there is nothing there to fail.
    assert.equal(fixedStreak(h, "2026-01-21"), 3);
  });

  it("reports the unit the habit currently commits in", () => {
    const nowWeekly = habit({ versions: [fixed(MONDAY), weekly("2026-01-12", 2)] });
    const nowFixed = habit({ versions: [weekly(MONDAY, 2), fixed("2026-01-12")] });
    assert.equal(effectiveKind(nowWeekly, "2026-01-20"), "weekly");
    assert.equal(effectiveKind(nowFixed, "2026-01-20"), "fixed");
  });

  /** Pausing is a schedule version, not a third kind: the unit must survive it. */
  it("looks past a current pause to find the real kind", () => {
    const h = habit({ versions: [weekly(MONDAY, 2), paused("2026-01-12")] });
    assert.equal(effectiveKind(h, "2026-01-15"), "weekly");
  });

  it("dispatches currentStreak on that kind", () => {
    const h = habit({
      versions: [weekly(MONDAY, 2)],
      logs: { "2026-01-05": "done", "2026-01-06": "done" },
    });
    assert.equal(currentStreak(h, "2026-01-09"), weeklyStreak(h, "2026-01-09"));
  });
});

/**
 * A windowed read (the monthly review) loads only part of the history. Measuring
 * from today would walk straight into days it never fetched, where a scheduled
 * day with no row is a failure — so the streak would break on missing data and
 * report zero.
 */
describe("the `through` horizon", () => {
  it("measures the streak at the edge of what was loaded", () => {
    const h = { ...habit({ logs: run(MONDAY, 5, "done") }), through: "2026-01-09" };
    // Today is weeks later and nothing was loaded past Jan 9.
    assert.equal(fixedStreak(h, "2026-02-01"), 5);
  });

  it("reports zero without it, which is the bug it exists to prevent", () => {
    const h = habit({ logs: run(MONDAY, 5, "done") });
    assert.equal(fixedStreak(h, "2026-02-01"), 0, "unfetched days read as failures");
  });

  it("still yields to an earlier archive date", () => {
    const h = {
      ...habit({ archivedOn: "2026-01-07", logs: run(MONDAY, 5, "done") }),
      through: "2026-01-09",
    };
    assert.equal(fixedStreak(h, "2026-02-01"), 3, "Jan 5-7 only");
  });

  it("is ignored when it is later than today", () => {
    const h = { ...habit({ logs: run(MONDAY, 5, "done") }), through: "2026-12-31" };
    assert.equal(fixedStreak(h, "2026-01-07"), 3, "today still caps the walk");
  });
});

describe("longest streak", () => {
  it("finds the best run, not the current one", () => {
    const h = habit({
      logs: {
        ...run(MONDAY, 5, "done"), // a run of 5
        "2026-01-10": "missed",
        ...run("2026-01-11", 2, "done"), // then a run of 2
      },
    });
    assert.equal(longestStreak(h, "2026-01-12"), 5);
    assert.equal(fixedStreak(h, "2026-01-12"), 2);
  });

  it("counts weeks for a weekly habit", () => {
    const h = habit({
      versions: [weekly(MONDAY, 1)],
      logs: {
        "2026-01-05": "done", // week 1 met
        "2026-01-12": "done", // week 2 met
        // week 3 missed entirely
        "2026-01-26": "done", // week 4 met
      },
    });
    assert.equal(longestStreak(h, "2026-02-02"), 2);
  });

  it("is zero for a habit that has never been done", () => {
    assert.equal(longestStreak(habit({}), "2026-01-09"), 0);
  });
});

describe("consistency", () => {
  const window = (to, from = MONDAY) => ({ from, to, today: to });

  it("is done over scheduled, for a fixed habit", () => {
    const logs = run(MONDAY, 10, "done"); // Jan 5-14 inclusive
    logs["2026-01-08"] = "missed";
    logs["2026-01-09"] = "missed";
    const result = consistency(habit({ logs }), window("2026-01-14"));

    // All ten days are decided — today counts because it was actually logged.
    assert.equal(result.opportunities, 10);
    assert.equal(result.done, 8);
    assert.equal(result.rate, 0.8);
  });

  /** A rest day is free: it leaves the denominator rather than lowering the rate. */
  it("removes skipped days from the denominator entirely", () => {
    const withSkip = run(MONDAY, 5, "done");
    withSkip["2026-01-07"] = "skipped";
    const result = consistency(habit({ logs: withSkip }), window("2026-01-10"));

    assert.equal(result.opportunities, 4, "the skipped day is not an opportunity");
    assert.equal(result.done, 4);
    assert.equal(result.rate, 1);
  });

  it("counts a never-logged past day against you", () => {
    const logs = run(MONDAY, 5, "done");
    delete logs["2026-01-07"];
    const result = consistency(habit({ logs }), window("2026-01-10"));
    assert.equal(result.opportunities, 5);
    assert.equal(result.done, 4);
  });

  it("leaves paused days out of the denominator", () => {
    const versions = [fixed(MONDAY), paused("2026-01-08"), fixed("2026-01-12")];
    const h = habit({ versions, logs: run(MONDAY, 3, "done") });
    const result = consistency(h, window("2026-01-12"));

    // Only Jan 5, 6, 7 were ever asked for; Jan 8-11 were paused.
    assert.equal(result.opportunities, 3);
    assert.equal(result.done, 3);
  });

  it("does not count today or the future", () => {
    const result = consistency(habit({ logs: run(MONDAY, 3, "done") }), window("2026-01-08"));
    assert.equal(result.opportunities, 3, "Jan 5-7 decided, Jan 8 is today");
  });

  it("returns a null rate when nothing was ever asked", () => {
    const h = habit({ versions: [paused(MONDAY)] });
    const result = consistency(h, window("2026-01-12"));
    assert.equal(result.opportunities, 0);
    assert.equal(result.rate, null, "nothing asked is not the same as nothing done");
  });

  describe("for a weekly habit", () => {
    it("uses the weekly target as the denominator", () => {
      const h = habit({
        versions: [weekly(MONDAY, 3)],
        logs: { "2026-01-05": "done", "2026-01-06": "done" },
      });
      const result = consistency(h, { from: MONDAY, to: "2026-01-11", today: "2026-01-19" });
      assert.equal(result.opportunities, 3);
      assert.equal(result.done, 2);
    });

    /** Five sessions against a target of three must not read as 166%. */
    it("caps a week's contribution at its target", () => {
      const h = habit({
        versions: [weekly(MONDAY, 2)],
        logs: run(MONDAY, 5, "done"),
      });
      const result = consistency(h, { from: MONDAY, to: "2026-01-11", today: "2026-01-19" });
      assert.equal(result.opportunities, 2);
      assert.equal(result.done, 2);
      assert.equal(result.rate, 1, "never above 100%");
    });

    it("ignores a week only partly inside the window", () => {
      const h = habit({ versions: [weekly(MONDAY, 2)], logs: run(MONDAY, 5, "done") });
      // Window stops mid-week, so the week is an incomplete unit.
      const result = consistency(h, { from: MONDAY, to: "2026-01-08", today: "2026-01-19" });
      assert.equal(result.opportunities, 0);
    });
  });
});
