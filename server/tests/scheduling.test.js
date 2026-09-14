/**
 * Resolving a habit's schedule for a given day, and classifying that day.
 *
 * This is the rule the whole consistency grid rests on: the version in force on
 * date D is the latest one that has started, and nothing resolves before the
 * habit's own start_date. Getting it wrong does not throw — it silently
 * re-scores history, which is exactly the failure the versioned schedule was
 * introduced to prevent.
 *
 * Pure functions, so no database and no fixtures.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  dayVerdict,
  isScheduledOn,
  resolveResumeSchedule,
  resolveSchedule,
  VERDICT,
  VERDICT_CHAR,
} from "../src/lib/scheduling.js";

const START = "2026-01-05"; // a Monday
const CHANGED = "2026-02-02"; // four weeks later, also a Monday

const fixed = (effective_from, schedule_days) => ({
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

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

/** Mirrors the seed's 'run': Mon/Wed/Fri, later moved to Tue/Thu. */
const scheduleChange = [fixed(START, [1, 3, 5]), fixed(CHANGED, [2, 4])];

/** Mirrors the seed's 'read': daily, paused for a week, then daily again. */
const pausedSpan = [fixed(START, EVERY_DAY), paused("2026-02-02"), fixed("2026-02-09", EVERY_DAY)];

describe("schedule resolution", () => {
  it("resolves nothing before the habit started", () => {
    assert.equal(resolveSchedule(scheduleChange, START, "2026-01-04"), null);
    assert.equal(resolveSchedule(scheduleChange, START, "2025-12-31"), null);
  });

  it("resolves the first version on the start date itself", () => {
    assert.deepEqual(resolveSchedule(scheduleChange, START, START).schedule_days, [1, 3, 5]);
  });

  it("keeps the old version for every day before the change", () => {
    for (const date of ["2026-01-05", "2026-01-20", "2026-02-01"]) {
      const schedule = resolveSchedule(scheduleChange, START, date);
      assert.deepEqual(schedule.schedule_days, [1, 3, 5], `wrong version on ${date}`);
    }
  });

  it("switches on the day the new version takes effect, not before", () => {
    assert.deepEqual(resolveSchedule(scheduleChange, START, "2026-02-01").schedule_days, [1, 3, 5]);
    assert.deepEqual(resolveSchedule(scheduleChange, START, CHANGED).schedule_days, [2, 4]);
  });

  it("keeps the latest version indefinitely", () => {
    assert.deepEqual(resolveSchedule(scheduleChange, START, "2027-06-30").schedule_days, [2, 4]);
  });

  it("resolves nothing when the habit has no versions at all", () => {
    assert.equal(resolveSchedule([], START, START), null);
  });
});

describe("paused spans", () => {
  it("resolves as paused for every day of the pause", () => {
    for (const date of ["2026-02-02", "2026-02-05", "2026-02-08"]) {
      const schedule = resolveSchedule(pausedSpan, START, date);
      assert.equal(schedule.schedule_kind, "paused", `not paused on ${date}`);
      assert.equal(schedule.schedule_days, null);
      assert.equal(schedule.weekly_target, null);
    }
  });

  it("is scheduled again the day the pause ends", () => {
    assert.equal(resolveSchedule(pausedSpan, START, "2026-02-08").schedule_kind, "paused");

    const resumed = resolveSchedule(pausedSpan, START, "2026-02-09");
    assert.equal(resumed.schedule_kind, "fixed");
    assert.deepEqual(resumed.schedule_days, EVERY_DAY);
  });

  it("still resolves normally before the pause began", () => {
    assert.equal(resolveSchedule(pausedSpan, START, "2026-02-01").schedule_kind, "fixed");
  });
});

/**
 * What a pause hides, and what the interface needs back.
 *
 * A paused version stores no days and no target, so resolveSchedule() alone
 * cannot tell anyone what the habit was. Everything here exists so that
 * resuming restores the commitment that was interrupted rather than inventing
 * one — inventing one turned a Tue/Thu habit into an every-day habit, which
 * then failed five days a week.
 */
describe("resolveResumeSchedule", () => {
  it("reports the fixed days the pause interrupted, not a default", () => {
    const versions = [fixed(START, [2, 4]), paused(CHANGED)];
    const resume = resolveResumeSchedule(versions, START, "2026-02-10");

    assert.equal(resume.schedule_kind, "fixed");
    assert.deepEqual(resume.schedule_days, [2, 4]);
    assert.equal(resume.weekly_target, null);
  });

  it("reports the weekly target the pause interrupted, not three", () => {
    const versions = [weekly(START, 5), paused(CHANGED)];
    const resume = resolveResumeSchedule(versions, START, "2026-02-10");

    assert.equal(resume.schedule_kind, "weekly");
    assert.equal(resume.weekly_target, 5);
    assert.equal(resume.schedule_days, null);
  });

  /** The one before the pause, not the oldest one that was ever set. */
  it("takes the most recent commitment, across several changes", () => {
    const versions = [fixed(START, [1, 3, 5]), weekly("2026-01-19", 4), paused(CHANGED)];
    const resume = resolveResumeSchedule(versions, START, "2026-02-10");

    assert.equal(resume.schedule_kind, "weekly");
    assert.equal(resume.weekly_target, 4);
  });

  it("ignores versions that have not taken effect yet", () => {
    const versions = [fixed(START, [2, 4]), paused("2026-01-19"), weekly(CHANGED, 6)];

    assert.deepEqual(
      resolveResumeSchedule(versions, START, "2026-01-26").schedule_days,
      [2, 4],
      "a future version must not be handed back as what to resume to",
    );
    assert.equal(resolveResumeSchedule(versions, START, CHANGED).weekly_target, 6);
  });

  /** Nothing was ever asked, so there is nothing to restore. */
  it("is null for a habit paused from its very first version", () => {
    assert.equal(resolveResumeSchedule([paused(START)], START, "2026-02-10"), null);
  });

  it("is null before the habit started", () => {
    assert.equal(resolveResumeSchedule([fixed(START, [2, 4])], START, "2026-01-04"), null);
  });
});

describe("weekly targets", () => {
  it("carries the target of the version in force", () => {
    const versions = [weekly(START, 3), weekly(CHANGED, 5)];
    assert.equal(resolveSchedule(versions, START, "2026-01-20").weekly_target, 3);
    assert.equal(resolveSchedule(versions, START, CHANGED).weekly_target, 5);
  });

  it("can switch a habit between fixed and weekly over time", () => {
    const versions = [fixed(START, [1, 3, 5]), weekly(CHANGED, 4)];

    const before = resolveSchedule(versions, START, "2026-01-19");
    assert.equal(before.schedule_kind, "fixed");
    assert.equal(before.weekly_target, null);

    const later = resolveSchedule(versions, START, "2026-02-16");
    assert.equal(later.schedule_kind, "weekly");
    assert.equal(later.schedule_days, null);
    assert.equal(later.weekly_target, 4);
  });
});

describe("isScheduledOn", () => {
  it("matches ISO weekdays under a fixed schedule", () => {
    const schedule = fixed(START, [1, 3, 5]); // Mon, Wed, Fri
    assert.equal(isScheduledOn(schedule, "2026-01-05"), true, "Monday");
    assert.equal(isScheduledOn(schedule, "2026-01-06"), false, "Tuesday");
    assert.equal(isScheduledOn(schedule, "2026-01-07"), true, "Wednesday");
    assert.equal(isScheduledOn(schedule, "2026-01-11"), false, "Sunday");
  });

  /**
   * A weekly schedule sets a count, not days, so no individual day is scheduled
   * under one. That is why a weekly habit can never accrue 'unlogged' failures.
   */
  it("names no days under a weekly or paused schedule", () => {
    assert.equal(isScheduledOn(weekly(START, 3), "2026-01-05"), false);
    assert.equal(isScheduledOn(paused(START), "2026-01-05"), false);
    assert.equal(isScheduledOn(null, "2026-01-05"), false);
  });
});

describe("day verdicts", () => {
  const TODAY = "2026-01-20";
  const daily = fixed(START, EVERY_DAY);

  const verdict = (overrides) =>
    dayVerdict({ schedule: daily, date: "2026-01-10", today: TODAY, ...overrides });

  it("reports logged statuses on a scheduled day", () => {
    assert.equal(verdict({ status: "done" }), VERDICT.DONE);
    assert.equal(verdict({ status: "skipped" }), VERDICT.SKIPPED);
    assert.equal(verdict({ status: "missed" }), VERDICT.MISSED);
  });

  /**
   * The four-state rule: a day with no row is not the same claim as a day
   * explicitly marked missed, and both must survive into the UI.
   */
  it("separates a never-logged past day from an explicit miss", () => {
    assert.equal(verdict({ status: null }), VERDICT.UNLOGGED);
    assert.equal(verdict({ status: "missed" }), VERDICT.MISSED);
  });

  it("treats today and the future as not yet due", () => {
    assert.equal(verdict({ date: TODAY, status: null }), VERDICT.FUTURE);
    assert.equal(verdict({ date: "2026-02-01", status: null }), VERDICT.FUTURE);
  });

  it("still honours an explicit status on today", () => {
    assert.equal(verdict({ date: TODAY, status: "missed" }), VERDICT.MISSED);
    assert.equal(verdict({ date: TODAY, status: "done" }), VERDICT.DONE);
  });

  it("is inactive before the start and after the archive", () => {
    assert.equal(verdict({ schedule: null }), VERDICT.INACTIVE);
    assert.equal(verdict({ archivedOn: "2026-01-09" }), VERDICT.INACTIVE);
    assert.equal(verdict({ archivedOn: "2026-01-10", status: "done" }), VERDICT.DONE);
  });

  it("marks an unscheduled weekday unscheduled, and a done one a bonus", () => {
    const monWedFri = fixed(START, [1, 3, 5]);
    // 2026-01-06 is a Tuesday.
    assert.equal(
      dayVerdict({ schedule: monWedFri, date: "2026-01-06", today: TODAY, status: null }),
      VERDICT.UNSCHEDULED,
    );
    assert.equal(
      dayVerdict({ schedule: monWedFri, date: "2026-01-06", today: TODAY, status: "done" }),
      VERDICT.BONUS,
    );
  });

  it("never turns an unscheduled day into a failure", () => {
    const monWedFri = fixed(START, [1, 3, 5]);
    for (const status of [null, "missed", "skipped"]) {
      const result = dayVerdict({
        schedule: monWedFri,
        date: "2026-01-06",
        today: TODAY,
        status,
      });
      assert.notEqual(result, VERDICT.UNLOGGED, `status ${status}`);
      assert.notEqual(result, VERDICT.MISSED, `status ${status}`);
    }
  });

  describe("under a pause", () => {
    const pause = paused(START);

    it("is neutral whatever was or was not logged", () => {
      for (const status of [null, "missed", "skipped"]) {
        assert.equal(
          dayVerdict({ schedule: pause, date: "2026-01-10", today: TODAY, status }),
          VERDICT.PAUSED,
          `status ${status}`,
        );
      }
    });

    /**
     * Doing it anyway during a pause is real and worth showing. It scores as a
     * bonus — nothing was asked — so it is generous to display and neutral to
     * every metric.
     */
    it("still shows a day that was done anyway", () => {
      assert.equal(
        dayVerdict({ schedule: pause, date: "2026-01-10", today: TODAY, status: "done" }),
        VERDICT.BONUS,
      );
    });
  });

  describe("under a weekly schedule", () => {
    const target = weekly(START, 3);
    const weeklyVerdict = (overrides) =>
      dayVerdict({ schedule: target, date: "2026-01-10", today: TODAY, ...overrides });

    it("counts any done day, since no day in particular was named", () => {
      assert.equal(weeklyVerdict({ status: "done" }), VERDICT.DONE);
    });

    it("never produces an unlogged failure", () => {
      assert.equal(weeklyVerdict({ status: null }), VERDICT.UNSCHEDULED);
      assert.equal(weeklyVerdict({ date: TODAY, status: null }), VERDICT.FUTURE);
    });
  });
});

describe("grid legend", () => {
  it("maps every verdict to a distinct character", () => {
    const verdicts = Object.values(VERDICT);
    const chars = verdicts.map((verdict) => VERDICT_CHAR[verdict]);

    for (const [index, char] of chars.entries()) {
      assert.equal(typeof char, "string", `${verdicts[index]} has no character`);
      assert.equal(char.length, 1, `${verdicts[index]} maps to ${JSON.stringify(char)}`);
    }
    assert.equal(new Set(chars).size, verdicts.length, "two verdicts share a character");
  });

  /** The grid has to keep these apart: one is a confession, the other a gap. */
  it("keeps missed and unlogged visually distinct", () => {
    assert.notEqual(VERDICT_CHAR[VERDICT.MISSED], VERDICT_CHAR[VERDICT.UNLOGGED]);
  });
});
