/**
 * Streaks and consistency.
 *
 * Two algorithms, not one generic one: a fixed habit counts consecutive *days*
 * and a weekly habit counts consecutive *weeks*, and forcing those into a single
 * function would mean inventing a period abstraction for exactly two cases. What
 * they genuinely share is the per-day verdict, which lives in scheduling.js and
 * which the grid and the review use too.
 *
 * Nothing here is stored. Streaks are recomputed on every read, which is what
 * makes retroactive edits simply work: log a day you forgot and the streak that
 * depended on it is correct immediately, with no backfill and nothing to migrate.
 *
 * Every function takes the same `habit` view:
 *
 *   {
 *     startDate:  'YYYY-MM-DD',
 *     archivedOn: 'YYYY-MM-DD' | null,   // calendar day of archiving
 *     through:    'YYYY-MM-DD' | null,   // last day `logs` covers (see lastDay)
 *     versions:   [schedule rows, ascending by effective_from],
 *     logs:       Map<'YYYY-MM-DD', 'done' | 'missed' | 'skipped'>,
 *   }
 *
 * and `today`, which is always the application's today from lib/dates.js — never
 * the server clock.
 */
import { addDays, eachDay, startOfWeek } from "./dates.js";
import { dayVerdict, isScheduledOn, resolveSchedule, VERDICT } from "./scheduling.js";

const WEEK_LENGTH = 7;

/** Verdicts that end a fixed streak. Skipped is deliberately not among them. */
const FAILURES = new Set([VERDICT.MISSED, VERDICT.UNLOGGED]);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * The last day the habit was answerable for.
 *
 * Three things can end the walk, and the earliest wins:
 *
 *   today       the normal case.
 *   archivedOn  an archived habit keeps the streak it had when it was archived,
 *               rather than decaying to zero the day after.
 *   through     the last day the caller actually loaded logs for.
 *
 * `through` is not a nicety. A caller that loads a window of history and then
 * measures from today walks straight into days it never fetched, and a scheduled
 * day with no row is a failure — so the streak breaks on missing data and
 * reports zero. Capping the walk at the edge of what was loaded is what makes a
 * windowed read (the monthly review) report the streak as it stood at the end of
 * that window.
 */
function lastDay(habit, today) {
  const horizon = habit.through && habit.through < today ? habit.through : today;
  return habit.archivedOn && habit.archivedOn < horizon ? habit.archivedOn : horizon;
}

function scheduleOn(habit, date) {
  return resolveSchedule(habit.versions, habit.startDate, date);
}

function verdictOn(habit, date, today) {
  return dayVerdict({
    schedule: scheduleOn(habit, date),
    status: habit.logs.get(date) ?? null,
    date,
    today,
    archivedOn: habit.archivedOn,
  });
}

const isActive = (habit, date) =>
  date >= habit.startDate && (!habit.archivedOn || date <= habit.archivedOn);

/**
 * The kind the habit is currently understood to be, for choosing which streak to
 * show. A paused habit is still a fixed or weekly habit — pausing is a schedule
 * version, not a third kind — so the most recent version that actually named a
 * commitment is the one that decides the unit.
 */
export function effectiveKind(habit, today) {
  const end = lastDay(habit, today);
  for (let index = habit.versions.length - 1; index >= 0; index -= 1) {
    const version = habit.versions[index];
    if (version.effective_from > end) continue;
    if (version.schedule_kind !== "paused") return version.schedule_kind;
  }
  return "fixed";
}

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

/**
 * Scores one ISO week (Monday-anchored) for a habit.
 *
 * The single rule that resolves every mid-week case: a week that was not fully
 * lived is **provisional** — it can be satisfied, but it can never fail. That
 * covers the current week, a week a pause starts or ends in, and a week that
 * straddles the habit's start or archive date, all with the same arithmetic.
 *
 * Returns:
 *   active      the habit existed for at least one day of this week
 *   scored      the week actually asked something (not wholly paused, and under
 *               a fixed schedule at least one day was scheduled)
 *   met         the commitment was satisfied
 *   fullyLived  entirely in the past, entirely active, and nowhere paused
 *   done/target for display; target is null under a fixed schedule
 */
export function scoreWeek(habit, weekStart, today) {
  const days = eachDay(weekStart, addDays(weekStart, WEEK_LENGTH - 1));
  const activeDays = days.filter((date) => isActive(habit, date));

  if (activeDays.length === 0) return { active: false, scored: false, met: false };

  const verdicts = new Map(activeDays.map((date) => [date, verdictOn(habit, date, today)]));

  // Paused-ness is read from the schedule version, never from the verdict: a day
  // worked during a pause reports BONUS rather than PAUSED, and treating that as
  // "not paused" would pick it as the scoring day and then score the week under
  // the paused version it still belongs to.
  const isPaused = (date) => scheduleOn(habit, date)?.schedule_kind === "paused";
  const pausedDays = activeDays.filter(isPaused);

  // Which version scores the week: the one in force on its first active,
  // unpaused day. Using the first active day outright would score a week whose
  // pause ends on Thursday as paused, throwing away the days actually worked.
  const firstScorable = activeDays.find((date) => !isPaused(date));
  const fullyLived =
    days[WEEK_LENGTH - 1] < today && activeDays.length === WEEK_LENGTH && pausedDays.length === 0;

  if (!firstScorable) {
    // Wholly paused: nothing was asked, so the week is neutral.
    return { active: true, scored: false, met: false, fullyLived: false, done: 0, target: null };
  }

  const version = scheduleOn(habit, firstScorable);

  if (version.schedule_kind === "weekly") {
    // Counted from the log rather than the verdict so that days worked during a
    // pause still count toward the week — they can only help, and a provisional
    // week cannot fail.
    const done = activeDays.filter((date) => habit.logs.get(date) === "done").length;
    const target = version.weekly_target;
    return { active: true, scored: true, met: done >= target, fullyLived, done, target };
  }

  // Fixed schedule inside a weekly habit's history (or a fixed habit being
  // scored by week for the longest-streak scan): the week is met when none of
  // its scheduled days failed.
  const scheduledDays = activeDays.filter((date) => isScheduledOn(scheduleOn(habit, date), date));
  const done = activeDays.filter((date) => verdicts.get(date) === VERDICT.DONE).length;

  if (scheduledDays.length === 0) {
    // A fixed week with nothing scheduled in it asks nothing and so neither
    // satisfies nor fails.
    return { active: true, scored: false, met: false, fullyLived, done, target: null };
  }

  const failed = activeDays.some((date) => FAILURES.has(verdicts.get(date)));
  return { active: true, scored: true, met: !failed, fullyLived, done, target: null };
}

/** Every Monday from the habit's first week to `end`'s week, oldest first. */
function weekStarts(habit, end) {
  const first = startOfWeek(habit.startDate);
  const out = [];
  for (let week = startOfWeek(end); week >= first; week = addDays(week, -WEEK_LENGTH)) {
    out.unshift(week);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Current streak
// ---------------------------------------------------------------------------

/**
 * Consecutive scheduled days satisfied, walking back from today.
 *
 * `skipped` continues the streak — that is the entire reason the status exists.
 * So do paused days, unscheduled days and bonus days: none of them is a day the
 * habit was failed on. Today, unlogged, is FUTURE and therefore neutral, so an
 * unticked habit at 9am never reads as broken; an *explicitly* missed today does
 * break it, because the user said so and that is finished information.
 */
export function fixedStreak(habit, today) {
  let streak = 0;

  for (let date = lastDay(habit, today); date >= habit.startDate; date = addDays(date, -1)) {
    const verdict = verdictOn(habit, date, today);
    if (verdict === VERDICT.DONE) streak += 1;
    else if (FAILURES.has(verdict) || verdict === VERDICT.INACTIVE) break;
  }

  return streak;
}

/**
 * Consecutive weeks meeting target, walking back from this week.
 *
 * Weeks governed by a *fixed* version are scored too, rather than stopping the
 * count at the boundary. A habit that was fixed for six months and became weekly
 * today would otherwise lose its whole streak as a side effect of an edit, which
 * is the worst thing a habit tracker can do.
 */
export function weeklyStreak(habit, today) {
  const first = startOfWeek(habit.startDate);
  let streak = 0;

  for (
    let week = startOfWeek(lastDay(habit, today));
    week >= first;
    week = addDays(week, -WEEK_LENGTH)
  ) {
    const scored = scoreWeek(habit, week, today);
    if (!scored.active) break;

    if (scored.scored && scored.met) streak += 1;
    else if (scored.scored && scored.fullyLived) break;
    // Unscored or provisional weeks are neutral: the streak passes through them.
  }

  return streak;
}

/** The streak to show, in the unit the habit currently commits in. */
export function currentStreak(habit, today) {
  return effectiveKind(habit, today) === "weekly"
    ? weeklyStreak(habit, today)
    : fixedStreak(habit, today);
}

// ---------------------------------------------------------------------------
// Longest streak
// ---------------------------------------------------------------------------

/**
 * The best run the habit ever had, in the same unit as currentStreak.
 *
 * NOTHING IN THE APP CALLS THIS, and that is not an oversight to be tidied away
 * by the next dead-code sweep. It was on the review payload until it was clear
 * no screen would ever be allowed to read it — the product states what happened
 * and does not frame a history as records to beat — so computing it per habit on
 * every review load was work with no possible consumer.
 *
 * The function stays because it is correct, exhaustively unit-tested, and the
 * only thing here that would be genuinely hard to write again: it scores every
 * week of a habit's life under whichever schedule kind governed it. If a use
 * ever appears that is not a scoreboard — an export, a diagnostic — it is ready.
 * Do not wire it back into a payload.
 */
export function longestStreak(habit, today) {
  return effectiveKind(habit, today) === "weekly"
    ? longestWeekly(habit, today)
    : longestFixed(habit, today);
}

function longestFixed(habit, today) {
  let best = 0;
  let run = 0;

  for (const date of eachDay(habit.startDate, lastDay(habit, today))) {
    const verdict = verdictOn(habit, date, today);
    if (verdict === VERDICT.DONE) {
      run += 1;
      best = Math.max(best, run);
    } else if (FAILURES.has(verdict)) {
      run = 0;
    }
  }

  return best;
}

function longestWeekly(habit, today) {
  let best = 0;
  let run = 0;

  for (const week of weekStarts(habit, lastDay(habit, today))) {
    const scored = scoreWeek(habit, week, today);
    if (!scored.active || !scored.scored) continue;

    if (scored.met) {
      run += 1;
      best = Math.max(best, run);
    } else if (scored.fullyLived) {
      run = 0;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Consistency
// ---------------------------------------------------------------------------

/**
 * True when no day of the week is governed by a fixed version.
 *
 * Only consistency needs this. Both streak algorithms want a mixed week read as
 * whatever its first day committed to, so that an edit never costs the run; the
 * ratio cannot be that relaxed, because its two loops sum into one denominator.
 */
const isWhollyWeekly = (habit, weekStart) =>
  eachDay(weekStart, addDays(weekStart, WEEK_LENGTH - 1)).every(
    (date) => scheduleOn(habit, date)?.schedule_kind !== "fixed",
  );

/**
 * How much of what was asked actually happened, over a window.
 *
 * Separate from the streak on purpose: a streak answers "am I going right now",
 * consistency answers "how am I doing overall", and one good week should not
 * disguise a bad month.
 *
 * Both halves are "opportunities taken / opportunities offered", so a window
 * spanning a change of schedule kind still sums coherently:
 *
 *   fixed days   every scheduled day that has been decided. Skipped days leave
 *                the denominator entirely — that is what makes a rest day free.
 *                Paused, unscheduled, bonus and not-yet-due days never enter it.
 *   weekly weeks only weeks lying wholly inside the window and fully lived, each
 *                contributing its target. Done days are capped at the target, or
 *                five sessions against a target of three would read as 166%.
 */
export function consistency(habit, { from, to, today }) {
  let done = 0;
  let opportunities = 0;

  for (const date of eachDay(from, to)) {
    if (!isActive(habit, date)) continue;
    if (scheduleOn(habit, date)?.schedule_kind !== "fixed") continue;

    const verdict = verdictOn(habit, date, today);
    if (verdict === VERDICT.DONE) {
      done += 1;
      opportunities += 1;
    } else if (FAILURES.has(verdict)) {
      opportunities += 1;
    }
  }

  for (const week of weekStarts(habit, to)) {
    // Only whole weeks inside the window; a half week at either edge is an
    // incomplete unit, exactly like the current one.
    if (week < from || addDays(week, WEEK_LENGTH - 1) > to) continue;

    const scored = scoreWeek(habit, week, today);
    if (!scored.scored || !scored.fullyLived || scored.target === null) continue;
    /*
     * ...and owning every day of it. The day loop above has already charged
     * each fixed-governed day on its own, so a week that a weekly-to-fixed
     * change split was billed twice over the same seven days: once as the
     * weekly target, and again as the fixed days inside it. Five of seven for a
     * week nothing ever asked seven of.
     *
     * setSchedule now defers a change of unit to the following Monday, so no
     * such week can be written any more. This keeps the two loops disjoint for
     * the ones already in the database, which no migration will revisit.
     */
    if (!isWhollyWeekly(habit, week)) continue;

    done += Math.min(scored.done, scored.target);
    opportunities += scored.target;
  }

  return {
    done,
    opportunities,
    // null, not 0: nothing was asked, which is not the same as nothing was done.
    rate: opportunities === 0 ? null : done / opportunities,
  };
}
