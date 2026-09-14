/**
 * What a habit meant on a given day.
 *
 * This is the rule the whole consistency grid rests on, and it is deliberately a
 * pure function over rows already in memory rather than a query. Every consumer
 * — the day screen, the grid, the monthly review, both streak algorithms — needs
 * the answer for a *range* of days, and resolving that in SQL means one lateral
 * subquery per (habit, day): ~840 of them for a twelve-week grid. A habit has a
 * handful of schedule versions in its whole life, so resolving in JavaScript is
 * both faster and far cheaper to test.
 *
 * Getting it wrong does not throw. It silently re-scores history, which is
 * exactly the failure the versioned schedule was introduced to prevent.
 */
import { isoWeekday } from "./dates.js";

/**
 * Every state a single day can be in, for one habit.
 *
 * Nine, because the schema insists on distinctions the UI has to keep: a day
 * nobody ever logged is not a day you looked at and admitted missing, and a day
 * you were never meant to act on is neither.
 */
export const VERDICT = {
  /** Before the habit started, or after it was archived. */
  INACTIVE: "inactive",
  /** A paused schedule version was in force. Neutral everywhere. */
  PAUSED: "paused",
  /** Active, but this weekday was not scheduled. */
  UNSCHEDULED: "unscheduled",
  /** Done on a day it was not scheduled. Counts for nothing, costs nothing. */
  BONUS: "bonus",
  DONE: "done",
  /** A deliberate exception. Never a failure. */
  SKIPPED: "skipped",
  /** Explicitly logged as missed — the user said so. */
  MISSED: "missed",
  /** Scheduled, in the past, and no row at all. A failure, but a quieter one. */
  UNLOGGED: "unlogged",
  /** Today or later: not yet due, so nothing to conclude. */
  FUTURE: "future",
};

/**
 * The schedule version in force on `date`, or null.
 *
 * `versions` must be ascending by effective_from. The rule, as documented on
 * habit_schedules: the latest version that has started, and nothing at all
 * before the habit's own start_date.
 */
export function resolveSchedule(versions, startDate, date) {
  if (date < startDate) return null;

  let current = null;
  for (const version of versions) {
    if (version.effective_from > date) break;
    current = version;
  }
  return current;
}

/**
 * The latest version at or before `date` that actually asked for something —
 * what a paused habit resumes to.
 *
 * Mirrors resolveSchedule(), skipping the pauses. It exists because a paused
 * version stores no days and no target, so resolveSchedule() alone leaves a
 * client with no way to know what the habit was: it has to invent a schedule to
 * resume on, and inventing one silently rewrites the habit. That is the same
 * re-scoring of history the versioned schedule was introduced to prevent, just
 * arriving through the interface instead of the database.
 *
 * Null when nothing was ever asked — a habit paused from its first version.
 */
export function resolveResumeSchedule(versions, startDate, date) {
  if (date < startDate) return null;

  let current = null;
  for (const version of versions) {
    if (version.effective_from > date) break;
    if (version.schedule_kind !== "paused") current = version;
  }
  return current;
}

/**
 * Whether the habit was meant to be done on this specific day.
 *
 * Only a fixed schedule names days. A weekly schedule sets a count and leaves
 * the choice of days open, so no individual day is scheduled under one — which
 * is why a weekly habit can never accumulate 'unlogged' failures.
 */
export function isScheduledOn(schedule, date) {
  if (schedule?.schedule_kind !== "fixed") return false;
  return schedule.schedule_days.includes(isoWeekday(date));
}

/**
 * Classifies one day for one habit.
 *
 * `status` is the habit_logs row's status, or null/undefined when there is no
 * row — a distinct state, and the reason this returns UNLOGGED rather than
 * folding it into MISSED.
 *
 * `today` decides what counts as decided. A scheduled day with no row is only a
 * failure once it is over; today and tomorrow are FUTURE, so an unticked habit
 * at 9am never shows a broken streak.
 */
export function dayVerdict({ schedule, status = null, date, today, archivedOn = null }) {
  if (archivedOn && date > archivedOn) return VERDICT.INACTIVE;
  if (!schedule) return VERDICT.INACTIVE;

  // Done is checked before paused on purpose: doing it anyway during a pause is
  // real and worth showing, and swallowing it as PAUSED would hide a day the
  // user actually earned. It scores as a bonus, because nothing was asked of
  // them — generous to display, neutral to every metric.
  if (status === "done") {
    // On a weekly schedule every day is a candidate, so a done day is simply
    // done; under a fixed or paused one, a day not asked for is a bonus.
    return isScheduledOn(schedule, date) || schedule.schedule_kind === "weekly"
      ? VERDICT.DONE
      : VERDICT.BONUS;
  }

  if (schedule.schedule_kind === "paused") return VERDICT.PAUSED;

  if (schedule.schedule_kind === "weekly") {
    if (status === "skipped") return VERDICT.SKIPPED;
    if (status === "missed") return VERDICT.MISSED;
    // No row, and no obligation attached to this particular day.
    return date >= today ? VERDICT.FUTURE : VERDICT.UNSCHEDULED;
  }

  if (!isScheduledOn(schedule, date)) return VERDICT.UNSCHEDULED;

  if (status === "skipped") return VERDICT.SKIPPED;
  if (status === "missed") return VERDICT.MISSED;

  return date >= today ? VERDICT.FUTURE : VERDICT.UNLOGGED;
}

/**
 * One character per verdict, for the grid's compact per-habit string.
 *
 * The grid is weeks * habits cells; as objects that is tens of kilobytes on a
 * phone, as a string it is hundreds of bytes. The legend lives here, beside the
 * encoding, and is documented in the API table rather than shipped per response.
 */
export const VERDICT_CHAR = {
  [VERDICT.INACTIVE]: "-",
  [VERDICT.PAUSED]: "p",
  [VERDICT.UNSCHEDULED]: ".",
  [VERDICT.BONUS]: "b",
  [VERDICT.DONE]: "d",
  [VERDICT.SKIPPED]: "s",
  [VERDICT.MISSED]: "m",
  [VERDICT.UNLOGGED]: "u",
  [VERDICT.FUTURE]: "f",
};
