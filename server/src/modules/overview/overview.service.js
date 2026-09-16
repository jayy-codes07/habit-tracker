/**
 * The read models the screens are actually shaped like.
 *
 * These are aggregate responses on purpose. The day screen needs habits, their
 * status, their streaks, today's tasks and the journal line; as separate
 * endpoints that is five round trips on a phone before anything renders. One
 * request, one paint.
 *
 * This module owns no tables. It composes the feature services and the pure
 * functions in lib/, which is what keeps the scoring rules in exactly one place.
 */
import {
  addDays,
  eachDay,
  endOfWeek,
  monthRange,
  startOfWeek,
  today as currentDate,
} from "../../lib/dates.js";
import { attainment } from "../../lib/attainment.js";
import {
  dayVerdict,
  isScheduledOn,
  resolveResumeSchedule,
  resolveSchedule,
  shapeSchedule,
  VERDICT,
  VERDICT_CHAR,
} from "../../lib/scheduling.js";
import {
  consistency,
  currentStreak,
  effectiveKind,
  longestStreak,
  scoreWeek,
} from "../../lib/streaks.js";
import * as habitsService from "../habits/habits.service.js";
import * as journalService from "../journal/journal.service.js";
import * as tasksService from "../tasks/tasks.service.js";

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * The shape lib/streaks.js works on. `through` is the last day `logs` covers.
 *
 * `values` is a sibling of `logs`, never a widening of it: lib/streaks.js reads
 * Map<date, status> and must keep reading exactly that, so that quantity cannot
 * reach a streak or a consistency rate even by accident. Only lib/attainment.js
 * looks at `values`.
 */
const toView = (habit, versions, logs, values, through) => ({
  startDate: habit.start_date,
  archivedOn: habit.archived_on,
  through,
  versions: versions ?? [],
  logs: logs ?? new Map(),
  values: values ?? new Map(),
});

const wasActiveBetween = (habit, from, to) =>
  habit.start_date <= to && (!habit.archived_on || habit.archived_on >= from);

/**
 * Habits that existed at any point in [from, to], with their versions and their
 * logs from the earliest start date up to `to`.
 *
 * The log window starts at the earliest start_date rather than at `from` because
 * a streak is only as correct as the history behind it: cutting it off at the
 * window edge would report a streak that silently stops at the fold. Only three
 * narrow columns are read, so a few thousand rows cost nothing.
 *
 * ponytail: unbounded history. Revisit if habit_logs ever passes ~100k rows —
 * at which point bound the window and label a clipped streak as "400+".
 */
async function loadWindow(from, to) {
  const all = await habitsService.loadHabits({ includeArchived: true });
  const habits = all.filter((habit) => wasActiveBetween(habit, from, to));
  if (habits.length === 0) return { habits: [], views: new Map() };

  const ids = habits.map((habit) => habit.id);
  const earliest = habits.reduce(
    (oldest, habit) => (habit.start_date < oldest ? habit.start_date : oldest),
    habits[0].start_date,
  );

  const [versions, logs, values] = await Promise.all([
    habitsService.loadVersions(ids),
    habitsService.loadLogs(ids, earliest, to),
    // Only the window asked for, not the whole history behind it: a streak needs
    // everything before it to be correct, an average of measured sessions does
    // not. See loadLogValues.
    habitsService.loadLogValues(ids, from, to),
  ]);

  return {
    habits,
    views: new Map(
      habits.map((h) => [
        h.id,
        toView(h, versions.get(h.id), logs.get(h.id), values.get(h.id), to),
      ]),
    ),
  };
}

/**
 * The date a streak should be measured up to.
 *
 * For today, that is today — an unlogged today is not yet due and must not break
 * anything. For a past day it is the morning after, so the day being looked at
 * is itself decided and counted: the streak reads as it stood when that day
 * ended, which is what someone scrolling back is asking about.
 */
const streakHorizon = (date, today) => (date < today ? addDays(date, 1) : today);

// ---------------------------------------------------------------------------
// The day screen
// ---------------------------------------------------------------------------

export async function buildDay(date) {
  const today = currentDate();
  const horizon = streakHorizon(date, today);

  const [{ habits, views }, dayLogs, tasks, journal] = await Promise.all([
    loadWindow(date, date),
    habitsService.loadDayLogs(date),
    tasksService.loadTasksForDay(date),
    journalService.loadEntry(date, "day"),
  ]);

  /*
   * Archiving takes a habit off the list at once, including on the day it
   * happened. loadWindow keeps a habit whose archived_on is on or after the day
   * being read, which is right for every past day — the grid paints those days
   * too, and the two screens must not disagree about a day that was lived — but
   * for today it left a habit you had just archived sitting in the list, still
   * tickable, until midnight.
   *
   * Only today and later are filtered, so the day it was archived on is still
   * reachable by stepping back to it tomorrow.
   */
  const listed = date < today ? habits : habits.filter((habit) => !habit.archived_on);

  return {
    date,
    // So the client can render "Today" without consulting its own clock, and
    // agree with the server about when the day rolls over.
    today,
    habits: listed.map((habit) => {
      const view = views.get(habit.id);
      const schedule = resolveSchedule(view.versions, habit.start_date, date);
      const log = dayLogs.get(habit.id) ?? null;
      const kind = effectiveKind(view, horizon);
      const paused = schedule?.schedule_kind === "paused";

      return {
        id: habit.id,
        name: habit.name,
        color_token: habit.color_token,
        schedule_kind: kind,
        scheduled: isScheduledOn(schedule, date),
        // A fact about the habit, not about the day. The client used to read it
        // off `verdict`, which cannot carry it: a paused day that was worked
        // reports `bonus`, so a habit paused on a day it was ticked looked
        // active and offered no way back.
        paused,
        // What "Resume" will restore — its target included, which is the whole
        // reason the target is versioned: a pause stores none, so without this
        // the client would have to invent one. Null unless paused — see
        // present() in habits.controller.js, which reports the same pair.
        resumes_to: paused
          ? shapeSchedule(resolveResumeSchedule(view.versions, habit.start_date, date))
          : null,
        /*
         * The two halves of quantity, side by side and both nullable.
         *
         * `unit` is the habit's and is the only thing that says this habit is
         * measured at all; `target_value` is this *day's*, resolved from the
         * version in force on it, so a day lived under a 5 km target keeps
         * saying 5 after the target becomes 10. A paused day has no target and
         * a quantity habit may simply not have one, so null here means "nothing
         * to aim at today", never "not a quantity habit".
         */
        unit: habit.unit,
        target_value: schedule?.target_value ?? null,
        status: log?.status ?? null,
        // What was actually measured. Null is a real answer on a done day:
        // it means the habit was done and not measured.
        value: log?.value ?? null,
        note: log?.note ?? null,
        verdict: dayVerdict({
          schedule,
          status: log?.status ?? null,
          date,
          today,
          archivedOn: habit.archived_on,
        }),
        streak: currentStreak(view, horizon),
        // Weekly habits show progress toward the week, not a day streak:
        // "2 of 3 this week" is the honest reading.
        week: kind === "weekly" ? weekProgress(view, date, horizon) : null,
      };
    }),
    tasks,
    journal,
  };
}

function weekProgress(view, date, horizon) {
  const week = scoreWeek(view, startOfWeek(date), horizon);
  return week.scored ? { done: week.done, target: week.target, met: week.met } : null;
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/**
 * A week-aligned consistency grid.
 *
 * Always whole Monday-to-Sunday weeks: the range ends on the Sunday of the week
 * containing `end` and starts `weeks - 1` weeks before that week's Monday, so
 * every row is exactly weeks * 7 characters and the client can index a cell by
 * offset without parsing a single date.
 */
export async function buildGrid({ end, weeks }) {
  const today = currentDate();
  const last = endOfWeek(end);
  const start = addDays(startOfWeek(end), -(weeks - 1) * 7);

  const { habits, views } = await loadWindow(start, last);
  const days = eachDay(start, last);

  return {
    start,
    end: last,
    weeks,
    today,
    habits: habits.map((habit) => {
      const view = views.get(habit.id);
      const kind = effectiveKind(view, today);

      return {
        id: habit.id,
        name: habit.name,
        color_token: habit.color_token,
        schedule_kind: kind,
        // A retired habit keeps its history here — a row that simply stopped,
        // with nothing to say whether it was abandoned or put away, is the
        // difference between a record and an accusation.
        archived_on: habit.archived_on,
        cells: days
          .map(
            (date) =>
              VERDICT_CHAR[
                dayVerdict({
                  schedule: resolveSchedule(view.versions, habit.start_date, date),
                  status: view.logs.get(date) ?? null,
                  date,
                  today,
                  archivedOn: habit.archived_on,
                })
              ],
          )
          .join(""),
        // Only weekly habits have a per-week target to report; a fixed row is
        // fully described by its cells.
        weeks:
          kind === "weekly"
            ? weekStartsBetween(start, last).map((weekStart) => {
                const week = scoreWeek(view, weekStart, today);
                return {
                  start: weekStart,
                  done: week.done ?? 0,
                  target: week.target ?? null,
                  met: Boolean(week.met),
                };
              })
            : null,
      };
    }),
  };
}

function weekStartsBetween(start, last) {
  const out = [];
  for (let week = start; week <= last; week = addDays(week, 7)) out.push(week);
  return out;
}

// ---------------------------------------------------------------------------
// The monthly review
// ---------------------------------------------------------------------------

/**
 * What a month actually amounted to.
 *
 * Consistency and streak answer different questions and are both reported:
 * a streak says "am I going right now", consistency says "how did the month go",
 * and one good week should not disguise a bad month.
 */
export async function buildReview(month) {
  const today = currentDate();
  const { start, end } = monthRange(month);
  // Never score days that have not happened yet.
  const to = end < today ? end : today;

  const [{ habits, views }, tasks, entries, reflection] = await Promise.all([
    // `to`, not `end`: loading past the scorable edge would leave the streak
    // walking over days that have not happened, and streaks are measured to the
    // end of what was loaded.
    loadWindow(start, to),
    reviewTasks(start, end),
    journalService.loadDayEntries(start, end),
    journalService.loadEntry(start, "month"),
  ]);

  return {
    month,
    start,
    end,
    habits: habits.map((habit) => {
      const view = views.get(habit.id);
      const rate = consistency(view, { from: start, to, today });
      /*
       * Reported beside consistency, never folded into it. They answer two
       * different questions and a habit can honestly score 100% on one and 60%
       * on the other: showing up three times a week is the commitment, and five
       * kilometres a time is the aspiration. Merging them would quietly turn
       * `weekly × 3` into a weekly-volume habit.
       */
      const measured = attainment(view, { from: start, to });

      return {
        id: habit.id,
        name: habit.name,
        color_token: habit.color_token,
        schedule_kind: effectiveKind(view, today),
        // Null for a binary habit, which is what makes the two rates below
        // readable: no unit, nothing was ever being measured.
        unit: habit.unit,
        /*
         * Reported raw, and compared against this month rather than against
         * today. A habit archived *after* the month shown was fully alive
         * through it, and that month must keep reading the way it was lived —
         * so the client marks a row retired only when archived_on falls on or
         * before `end`.
         */
        archived_on: habit.archived_on,
        ...countVerdicts(view, habit, start, to, today),
        consistency: rate.rate,
        done_of: rate.opportunities,
        /*
         * How close the measured sessions came, 0..1, and how many there were.
         *
         * Both, always. A rate over two sessions and a rate over twenty are not
         * the same claim, and a quantity habit logged mostly without values
         * would otherwise read as a confident number resting on almost nothing.
         * Null when nothing was measured — which is not the same as falling
         * short, so it must never render as 0%.
         */
        attainment: measured.rate,
        attainment_of: measured.sessions,
        current_streak: currentStreak(view, today),
        longest_streak: longestStreak(view, today),
      };
    }),
    tasks,
    journal: { month: reflection, days: entries },
  };
}

/** Verdict tallies for the month, so the review can say what actually happened. */
function countVerdicts(view, habit, from, to, today) {
  const counts = { done: 0, missed: 0, skipped: 0, unlogged: 0, paused: 0, bonus: 0 };

  for (const date of eachDay(from, to)) {
    const verdict = dayVerdict({
      schedule: resolveSchedule(view.versions, habit.start_date, date),
      status: view.logs.get(date) ?? null,
      date,
      today,
      archivedOn: habit.archived_on,
    });

    if (verdict === VERDICT.DONE) counts.done += 1;
    else if (verdict === VERDICT.MISSED) counts.missed += 1;
    else if (verdict === VERDICT.SKIPPED) counts.skipped += 1;
    else if (verdict === VERDICT.UNLOGGED) counts.unlogged += 1;
    else if (verdict === VERDICT.PAUSED) counts.paused += 1;
    else if (verdict === VERDICT.BONUS) counts.bonus += 1;
  }

  return counts;
}

async function reviewTasks(start, end) {
  const { completed, created } = await tasksService.countTasksBetween(start, end);
  return { completed, created };
}
