/**
 * Development seed data.
 *
 * Deterministic: no randomness anywhere. Everything is derived from today's date
 * by fixed offsets, so the same day always produces the same database, while the
 * history stays adjacent to today — which is what makes a consistency grid and a
 * streak calculation meaningful to look at.
 *
 * "The same day" is the date in the configured time zone (APP_TIMEZONE), read
 * once at import via today(). Two
 * runs that straddle local midnight therefore produce different data, and the
 * determinism test in tests/migrate-and-seed.test.js — which seeds twice and
 * compares digests — would fail with "re-seeding produced different data". That
 * edge is accepted rather than engineered around: freezing the date would cost
 * the adjacency to today that makes this fixture worth looking at, and the
 * failure is rare, self-healing on the next run, and cheap to recognise once
 * it is written down here.
 *
 * Re-runnable: truncates and rebuilds inside one transaction.
 *
 * This is also the fixture the streak and consistency tests will assert against,
 * so every pattern below is known by construction. The cases it deliberately
 * covers are listed in SEED_CASES at the bottom of this file.
 *
 *   npm run db:seed
 */
import { config } from "../../config/index.js";
import {
  addDays,
  addMonths,
  eachDay,
  instantOn,
  isoWeekday,
  monthOf,
  startOfWeek,
  today,
} from "../../lib/dates.js";
import { pool, withTransaction } from "../index.js";

// Dates are 'YYYY-MM-DD' strings throughout, which compare correctly with <=,
// so the ranges below need no parsing. The arithmetic lives in lib/dates.js -
// the same helpers the application uses, rather than a second copy of the
// noon-UTC trick that could drift away from it.

const TODAY = today();
const HISTORY_DAYS = 97; // 14 weeks of history, inclusive of today
const HISTORY_START = addDays(TODAY, -HISTORY_DAYS);

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

// Boundaries for the two history-shaping events. Week-aligned where a reader
// would expect a schedule change to land on a Monday.
const RUN_SCHEDULE_CHANGE = startOfWeek(addDays(TODAY, -42)); // Mon/Wed/Fri -> Tue/Thu
const READ_PAUSE_FROM = addDays(TODAY, -20); // a week away from the books
const READ_PAUSE_UNTIL = addDays(TODAY, -13); // reading resumes on this day

// ---------------------------------------------------------------------------
// Habits.
//
// A habit no longer carries its schedule: `schedules` is its version history,
// ascending by effective_from, and the first version always starts on
// start_date. Generators below resolve a date against these versions rather
// than reading a single fixed shape, which is the whole point of the change.
// ---------------------------------------------------------------------------

const habits = [
  {
    key: "run",
    name: "Morning run",
    color_token: "chart-1",
    sort_order: 1,
    start_date: HISTORY_START,
    // Changed schedule mid-history. Weeks before the change must stay scored on
    // Mon/Wed/Fri: this is the case that silently broke when the schedule lived
    // on the habit row.
    schedules: [
      { effective_from: HISTORY_START, kind: "fixed", days: [1, 3, 5] },
      { effective_from: RUN_SCHEDULE_CHANGE, kind: "fixed", days: [2, 4] },
    ],
  },
  {
    key: "read",
    name: "Read 20 pages",
    color_token: "chart-2",
    sort_order: 2,
    // Paused for a week, then resumed. The current streak has to survive the
    // pause: paused days are not scheduled, so there is nothing there to miss.
    start_date: HISTORY_START,
    schedules: [
      { effective_from: HISTORY_START, kind: "fixed", days: EVERY_DAY },
      { effective_from: READ_PAUSE_FROM, kind: "paused" },
      { effective_from: READ_PAUSE_UNTIL, kind: "fixed", days: EVERY_DAY },
    ],
  },
  {
    key: "meditate",
    name: "Meditate",
    color_token: "chart-3",
    sort_order: 3,
    start_date: HISTORY_START,
    schedules: [{ effective_from: HISTORY_START, kind: "fixed", days: EVERY_DAY }],
  },
  {
    key: "gym",
    name: "Gym",
    color_token: "chart-4",
    sort_order: 4,
    start_date: HISTORY_START,
    schedules: [{ effective_from: HISTORY_START, kind: "weekly", weeklyTarget: 3 }],
  },
  {
    key: "stretch",
    name: "Evening stretch",
    color_token: "chart-5",
    sort_order: 5,
    start_date: addDays(TODAY, -30), // starts partway through the history
    schedules: [{ effective_from: addDays(TODAY, -30), kind: "fixed", days: [2, 4] }],
  },
  {
    key: "cold",
    name: "Cold shower",
    color_token: "chart-1",
    sort_order: 6,
    start_date: HISTORY_START,
    schedules: [{ effective_from: HISTORY_START, kind: "fixed", days: [1, 2, 3, 4, 5] }],
    archived_days_ago: 10, // given up on, kept for history
  },
];

// Resolved once, before any generator runs, because the generators need to know
// where a habit's history stops.
for (const habit of habits) {
  habit.archived_on = habit.archived_days_ago ? addDays(TODAY, -habit.archived_days_ago) : null;
}

/**
 * The schedule in force on `date`: the latest version that has started. Nothing
 * resolves before start_date — the habit did not exist yet. Mirrors the rule
 * documented on habit_schedules in 001_init.sql, and the production resolver in
 * lib/scheduling.js.
 */
function resolveSchedule(habit, date) {
  if (date < habit.start_date) return null;
  let current = null;
  for (const version of habit.schedules) {
    if (version.effective_from > date) break;
    current = version;
  }
  return current;
}

/** Every date the habit was actually meant to be done, oldest first. */
function scheduledDates(habit) {
  return eachDay(habit.start_date, habit.archived_on ?? TODAY).filter((day) => {
    const version = resolveSchedule(habit, day);
    return version?.kind === "fixed" && version.days.includes(isoWeekday(day));
  });
}

// ---------------------------------------------------------------------------
// Logs. Each generator returns { date, status, note } rows.
//
// A day with no row is not the same as a logged failure, and the app produces
// both, so the seed produces both:
//   * no row at all        — never opened the app
//   * status = 'missed'    — looked at it, did not do it
//   * status = 'skipped'   — a deliberate exception; does not break a streak
// ---------------------------------------------------------------------------

/**
 * Offsets index the habit's own SCHEDULED days, counting back from its most
 * recent one (0 = latest). Calendar-day offsets would silently evaporate when
 * they landed on an unscheduled weekday, so the seed's coverage would change
 * depending on which weekday it happened to be run.
 */
function fixedLogs(
  habit,
  { noRowIndexes = [], missedIndexes = [], skippedIndexes = [], notes = {} },
) {
  const noRow = new Set(noRowIndexes);
  const missed = new Set(missedIndexes);
  const skipped = new Set(skippedIndexes);

  const scheduled = scheduledDates(habit);
  const lastIndex = scheduled.length - 1;

  return scheduled
    .map((day, i) => {
      const back = lastIndex - i; // 0 = most recent scheduled day
      if (noRow.has(back)) return null; // no row at all
      const status = missed.has(back) ? "missed" : skipped.has(back) ? "skipped" : "done";
      return { date: day, status, note: notes[back] ?? null };
    })
    .filter(Boolean);
}

/** Weekly-target habit: pick the first N candidate weekdays in each week. */
function weeklyLogs(habit, { candidates, countForWeek }) {
  const rows = [];
  const firstWeek = startOfWeek(habit.start_date);
  const currentWeek = startOfWeek(TODAY);
  const end = habit.archived_on ?? TODAY;

  for (let week = firstWeek, index = 0; week <= currentWeek; week = addDays(week, 7), index += 1) {
    const isCurrentWeek = week === currentWeek;
    const available = candidates
      .map((weekday) => addDays(week, weekday - 1))
      .filter((day) => day >= habit.start_date && day <= end)
      .filter((day) => resolveSchedule(habit, day)?.kind === "weekly");

    const target = countForWeek({ index, isCurrentWeek });
    for (const day of available.slice(0, target)) {
      rows.push({ date: day, status: "done", note: null });
    }
  }
  return rows;
}

const logPlans = {
  // Current streak is exactly 3: indexes 0-2 done, index 3 an explicit miss.
  // The two no-row gaps sit further back, on both sides of the schedule change.
  run: (h) =>
    fixedLogs(h, {
      noRowIndexes: [12, 25],
      missedIndexes: [3],
      notes: { 1: "Legs still heavy — took it slow." },
    }),

  // Long unbroken current streak that runs straight through the paused week,
  // with older gaps so longest and current differ.
  read: (h) => fixedLogs(h, { noRowIndexes: [41, 42, 67], notes: { 0: "Finished chapter 8." } }),

  // Patchy on purpose, and patchy in the *never logged* sense: every 3rd
  // scheduled day gets no row at all — the app was never opened that day — which
  // is a different claim from 'missed', a day that was looked at and not acted
  // on. This habit is the fixture for that distinction, so it deliberately
  // produces no 'missed' rows; 'run' and 'stretch' cover those. On top of it,
  // two rest days taken deliberately, as 'skipped'.
  meditate: (h) =>
    fixedLogs(h, {
      noRowIndexes: Array.from({ length: HISTORY_DAYS + 1 }, (_, i) => i).filter(
        (index) => index % 3 === 1,
      ),
      skippedIndexes: [6, 15],
    }),

  // Mon/Wed/Fri/Sat candidates. Current week deliberately short of target,
  // last week exactly on target, older weeks cycle over and under.
  gym: (h) =>
    weeklyLogs(h, {
      candidates: [1, 3, 5, 6],
      countForWeek: ({ index, isCurrentWeek }) => {
        if (isCurrentWeek) return 2; // partially complete: 2 of 3
        if (index % 4 === 0) return 3; // fully complete
        if (index % 4 === 1) return 3;
        if (index % 4 === 2) return 2; // target missed
        return 1;
      },
    }),

  // Scheduled days back from the most recent: 0 done, 1 skipped, 2-3 done,
  // 4 missed. The cleanest assertion that 'skipped' does not BREAK a streak —
  // the current streak here is 3, not 4, because a skipped day preserves the
  // streak without adding to it. You did not do it; you just did not fail.
  stretch: (h) => fixedLogs(h, { missedIndexes: [4], skippedIndexes: [1] }),

  // Abandoned before it was archived: the last four scheduled days have no rows.
  cold: (h) => fixedLogs(h, { noRowIndexes: [0, 1, 2, 3] }),
};

// ---------------------------------------------------------------------------
// Tasks and journal
// ---------------------------------------------------------------------------

const tasks = [
  { title: "Book dentist appointment", due_days: -6, completed: false }, // overdue
  { title: "Renew gym membership", due_days: -1, completed: false }, // overdue
  { title: "Call Mum", due_days: 0, completed: false }, // due today
  { title: "Pay electricity bill", due_days: 3, completed: false }, // upcoming
  { title: "Plan weekend trip", due_days: null, completed: false }, // no due date
  { title: "Order running shoes", due_days: -3, completed: true, completed_days_ago: 3 },
  { title: "Sort out old laptop", due_days: -20, completed: true, completed_days_ago: 18 },
  { title: "Cancel unused subscription", due_days: -40, completed: false, archived_days_ago: 35 },
];

const dayEntries = {
  0: "Good day. Ran early, work stayed calm, read before bed.",
  1: "Tired but kept the streak going. Skipped stretching.",
  2: "Long meetings. Squeezed the run in at lunch.",
  4: "Rest day. Finally sorted the laundry pile.",
  7: "Best week in a while — gym three times.",
  9: "Off day. Missed the run and the stretch, not going to pretend otherwise.",
  14: "Back to reading tonight after a week off. Missed it more than I expected.",
  16: "Deliberately not reading this week. Head needed the quiet.",
  21: "Back on track after a rough patch.",
  30: "Started evening stretching today. Knees will thank me.",
  42: "Moved the runs to Tuesday and Thursday. Mornings were never going to work.",
  45: "Travel day, everything slipped.",
  60: "Slow but steady. Reading is the habit that sticks best.",
  89: "Set this up properly today. Let us see if it lasts.",
};

const monthEntries = [
  {
    months_ago: 0,
    entry: "Consistent so far. Next month: hold the reading streak and get gym to three a week.",
  },
  {
    months_ago: 1,
    entry: "Reading carried the month; gym was patchy. Next month: stop skipping Mondays.",
  },
  {
    months_ago: 2,
    entry: "First full month of tracking. Next month: add evening stretching.",
  },
];

/** Monthly reflections are keyed to the first of their month (journal_month_anchored). */
function firstOfMonth(monthsAgo) {
  return `${addMonths(monthOf(TODAY), -monthsAgo)}-01`;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

async function seed() {
  if (config.env === "production" && !process.argv.includes("--force")) {
    throw new Error("Refusing to seed a production database. Pass --force if you really mean it.");
  }

  const counts = await withTransaction(async (client) => {
    // RESTART IDENTITY keeps ids stable across runs. habit_schedules and
    // habit_logs would fall to CASCADE anyway; naming them is documentation.
    await client.query(
      "TRUNCATE habits, habit_schedules, habit_logs, tasks, journal RESTART IDENTITY CASCADE",
    );

    const statusCounts = { done: 0, missed: 0, skipped: 0 };
    let scheduleCount = 0;

    for (const habit of habits) {
      const { rows } = await client.query(
        `INSERT INTO habits (name, color_token, sort_order, start_date, archived_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          habit.name,
          habit.color_token,
          habit.sort_order,
          habit.start_date,
          habit.archived_on ? instantOn(habit.archived_on) : null,
        ],
      );
      habit.id = rows[0].id;

      for (const version of habit.schedules) {
        await client.query(
          `INSERT INTO habit_schedules
             (habit_id, effective_from, schedule_kind, schedule_days, weekly_target)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            habit.id,
            version.effective_from,
            version.kind,
            version.days ?? null,
            version.weeklyTarget ?? null,
          ],
        );
        scheduleCount += 1;
      }

      for (const log of logPlans[habit.key](habit)) {
        await client.query(
          "INSERT INTO habit_logs (habit_id, date, status, note) VALUES ($1, $2, $3, $4)",
          [habit.id, log.date, log.status, log.note],
        );
        statusCounts[log.status] += 1;
      }
    }

    for (const task of tasks) {
      await client.query(
        `INSERT INTO tasks (title, due_date, completed, completed_at, archived_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          task.title,
          task.due_days === null || task.due_days === undefined
            ? null
            : addDays(TODAY, task.due_days),
          task.completed,
          task.completed ? instantOn(addDays(TODAY, -task.completed_days_ago)) : null,
          task.archived_days_ago ? instantOn(addDays(TODAY, -task.archived_days_ago)) : null,
        ],
      );
    }

    for (const [daysAgo, entry] of Object.entries(dayEntries)) {
      await client.query("INSERT INTO journal (date, kind, entry) VALUES ($1, 'day', $2)", [
        addDays(TODAY, -Number(daysAgo)),
        entry,
      ]);
    }

    for (const month of monthEntries) {
      await client.query("INSERT INTO journal (date, kind, entry) VALUES ($1, 'month', $2)", [
        firstOfMonth(month.months_ago),
        month.entry,
      ]);
    }

    return { statusCounts, scheduleCount };
  });

  const { done, missed, skipped } = counts.statusCounts;
  console.log(`[seed] today       ${TODAY} (ISO weekday ${isoWeekday(TODAY)}, ${config.timezone})`);
  console.log(`[seed] history     ${HISTORY_START} -> ${TODAY}`);
  console.log(`[seed] habits      ${habits.length}`);
  console.log(`[seed] schedules   ${counts.scheduleCount}`);
  console.log(`[seed] habit_logs  ${done + missed + skipped}`);
  console.log(`[seed]             done ${done} / missed ${missed} / skipped ${skipped}`);
  console.log(`[seed] tasks       ${tasks.length}`);
  console.log(
    `[seed] journal     ${Object.keys(dayEntries).length} day + ${monthEntries.length} month`,
  );
  console.log(`[seed] run schedule change  ${RUN_SCHEDULE_CHANGE}`);
  console.log(`[seed] read paused          ${READ_PAUSE_FROM} -> ${addDays(READ_PAUSE_UNTIL, -1)}`);
}

/**
 * What this fixture is for. Streak and consistency tests should assert against
 * these by name rather than rediscovering them:
 *
 *   run       schedule changed mid-history (Mon/Wed/Fri -> Tue/Thu);
 *             current streak 3, ended by an explicit 'missed'
 *   read      paused for a week; current streak runs through the pause
 *   meditate  patchy: every 3rd scheduled day has no row at all (never logged,
 *             not 'missed'), plus deliberate 'skipped' rest days
 *   gym       weekly target 3, current week short at 2
 *   stretch   starts mid-history; current streak 3 done days, spanning a
 *             'skipped' day that preserves the streak without incrementing it
 *   cold      archived, with no rows for its final scheduled days
 */

try {
  await seed();
} catch (error) {
  console.error(`[seed] ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
