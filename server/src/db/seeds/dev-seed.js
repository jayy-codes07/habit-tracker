/**
 * Development seed data.
 *
 * Deterministic: no randomness anywhere. Everything is derived from today's date
 * by fixed offsets, so the same day always produces the same database, while the
 * history stays adjacent to today — which is what makes a consistency grid and a
 * streak calculation meaningful to look at.
 *
 * Re-runnable: truncates and rebuilds inside one transaction.
 *
 *   npm run db:seed
 */
import { config } from "../../config/index.js";
import { pool, withTransaction } from "../index.js";

// ---------------------------------------------------------------------------
// Date helpers. All arithmetic happens at noon UTC so a DST transition can never
// push a date onto the wrong day, and dates cross the wire as 'YYYY-MM-DD'.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function todayLocal() {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12);
}

const toISO = (stamp) => new Date(stamp).toISOString().slice(0, 10);
const addDays = (stamp, days) => stamp + days * DAY_MS;

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
const isoWeekday = (stamp) => new Date(stamp).getUTCDay() || 7;

/** Monday of the week containing `stamp`. */
const startOfWeek = (stamp) => addDays(stamp, -(isoWeekday(stamp) - 1));

const TODAY = todayLocal();
const HISTORY_DAYS = 97; // 14 weeks of history, inclusive of today
const HISTORY_START = addDays(TODAY, -HISTORY_DAYS);

/** Every date from `from` to `to`, inclusive. */
function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------------------------------------------------------------------------
// Habits
// ---------------------------------------------------------------------------

const habits = [
  {
    key: "run",
    name: "Morning run",
    color_token: "chart-1",
    schedule_kind: "fixed",
    schedule_days: [1, 3, 5], // Mon / Wed / Fri — leaves unscheduled days in the grid
    weekly_target: null,
    sort_order: 1,
    start_date: HISTORY_START,
  },
  {
    key: "read",
    name: "Read 20 pages",
    color_token: "chart-2",
    schedule_kind: "fixed",
    schedule_days: [1, 2, 3, 4, 5, 6, 7], // every day
    weekly_target: null,
    sort_order: 2,
    start_date: HISTORY_START,
  },
  {
    key: "meditate",
    name: "Meditate",
    color_token: "chart-3",
    schedule_kind: "fixed",
    schedule_days: [1, 2, 3, 4, 5, 6, 7],
    weekly_target: null,
    sort_order: 3,
    start_date: HISTORY_START,
  },
  {
    key: "gym",
    name: "Gym",
    color_token: "chart-4",
    schedule_kind: "weekly",
    schedule_days: null,
    weekly_target: 3,
    sort_order: 4,
    start_date: HISTORY_START,
  },
  {
    key: "stretch",
    name: "Evening stretch",
    color_token: "chart-5",
    schedule_kind: "fixed",
    schedule_days: [2, 4], // Tue / Thu
    weekly_target: null,
    sort_order: 5,
    start_date: addDays(TODAY, -30), // starts partway through the history
  },
  {
    key: "cold",
    name: "Cold shower",
    color_token: "chart-1",
    schedule_kind: "fixed",
    schedule_days: [1, 2, 3, 4, 5],
    weekly_target: null,
    sort_order: 6,
    start_date: HISTORY_START,
    archived_days_ago: 10, // given up on, kept for history
  },
];

// ---------------------------------------------------------------------------
// Logs. Each generator returns { date, completed, note } rows.
//
// A missed day is represented two ways on purpose, because the app produces both:
//   * no row at all (never opened the app)
//   * a row with completed = false (ticked, then un-ticked)
// ---------------------------------------------------------------------------

/**
 * Offsets index the habit's own SCHEDULED days, counting back from its most
 * recent one (0 = latest). Calendar-day offsets would silently evaporate when
 * they landed on an unscheduled weekday, so the seed's coverage would change
 * depending on which weekday it happened to be run.
 */
function fixedLogs(habit, { missIndexes = [], explicitMissIndexes = [], notes = {} }) {
  const misses = new Set(missIndexes);
  const explicit = new Set(explicitMissIndexes);

  const scheduled = dateRange(habit.start_date, habit.archived_at ?? TODAY).filter((d) =>
    habit.schedule_days.includes(isoWeekday(d)),
  );
  const lastIndex = scheduled.length - 1;

  return scheduled
    .map((d, i) => {
      const back = lastIndex - i; // 0 = most recent scheduled day
      if (misses.has(back)) return null; // no row at all
      return {
        date: toISO(d),
        completed: !explicit.has(back),
        note: notes[back] ?? null,
      };
    })
    .filter(Boolean);
}

/** Weekly-target habit: pick the first N candidate weekdays in each week. */
function weeklyLogs(habit, { candidates, countForWeek }) {
  const rows = [];
  const firstWeek = startOfWeek(habit.start_date);
  const currentWeek = startOfWeek(TODAY);

  for (let week = firstWeek, index = 0; week <= currentWeek; week = addDays(week, 7), index += 1) {
    const isCurrentWeek = week === currentWeek;
    const available = candidates
      .map((weekday) => addDays(week, weekday - 1))
      .filter((d) => d >= habit.start_date && d <= TODAY);

    const target = countForWeek({ index, isCurrentWeek });
    for (const date of available.slice(0, target)) {
      rows.push({ date: toISO(date), completed: true, note: null });
    }
  }
  return rows;
}

const logPlans = {
  // Miss on the 3rd-most-recent scheduled day, recorded as an explicit
  // completed = false row, so the "what did I miss" list is never empty.
  run: (h) =>
    fixedLogs(h, {
      missIndexes: [12, 25],
      explicitMissIndexes: [3],
      notes: { 1: "Legs still heavy from Monday." },
    }),

  // Long unbroken current streak, with older gaps so longest differs from current.
  read: (h) => fixedLogs(h, { missIndexes: [41, 42, 67], notes: { 0: "Finished chapter 8." } }),

  // Patchy on purpose: every 3rd scheduled day missed, including recently.
  meditate: (h) =>
    fixedLogs(h, {
      missIndexes: Array.from({ length: HISTORY_DAYS + 1 }, (_, i) => i).filter(
        (index) => index % 3 === 1,
      ),
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

  stretch: (h) => fixedLogs(h, { explicitMissIndexes: [2] }),

  cold: (h) => fixedLogs(h, { missIndexes: [0, 1, 2, 3] }),
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
  14: "Quiet Sunday. Long walk, no screens after eight.",
  21: "Back on track after a rough patch.",
  30: "Started evening stretching today. Knees will thank me.",
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

function firstOfMonth(monthsAgo) {
  const now = new Date(TODAY);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1, 12);
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

async function seed() {
  if (config.env === "production" && !process.argv.includes("--force")) {
    throw new Error("Refusing to seed a production database. Pass --force if you really mean it.");
  }

  const counts = await withTransaction(async (client) => {
    // RESTART IDENTITY keeps ids stable across runs; CASCADE clears habit_logs
    // through the foreign key.
    await client.query("TRUNCATE habits, habit_logs, tasks, journal RESTART IDENTITY CASCADE");

    let logCount = 0;
    for (const habit of habits) {
      habit.archived_at = habit.archived_days_ago ? addDays(TODAY, -habit.archived_days_ago) : null;

      const { rows } = await client.query(
        `INSERT INTO habits
           (name, color_token, schedule_kind, schedule_days, weekly_target,
            sort_order, start_date, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          habit.name,
          habit.color_token,
          habit.schedule_kind,
          habit.schedule_days,
          habit.weekly_target,
          habit.sort_order,
          toISO(habit.start_date),
          habit.archived_at ? new Date(habit.archived_at).toISOString() : null,
        ],
      );
      habit.id = rows[0].id;

      for (const log of logPlans[habit.key](habit)) {
        await client.query(
          "INSERT INTO habit_logs (habit_id, date, completed, note) VALUES ($1, $2, $3, $4)",
          [habit.id, log.date, log.completed, log.note],
        );
        logCount += 1;
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
            : toISO(addDays(TODAY, task.due_days)),
          task.completed,
          task.completed ? new Date(addDays(TODAY, -task.completed_days_ago)).toISOString() : null,
          task.archived_days_ago
            ? new Date(addDays(TODAY, -task.archived_days_ago)).toISOString()
            : null,
        ],
      );
    }

    for (const [daysAgo, entry] of Object.entries(dayEntries)) {
      await client.query("INSERT INTO journal (date, kind, entry) VALUES ($1, 'day', $2)", [
        toISO(addDays(TODAY, -Number(daysAgo))),
        entry,
      ]);
    }

    for (const month of monthEntries) {
      await client.query("INSERT INTO journal (date, kind, entry) VALUES ($1, 'month', $2)", [
        toISO(firstOfMonth(month.months_ago)),
        month.entry,
      ]);
    }

    return { logCount };
  });

  console.log(`[seed] today       ${toISO(TODAY)} (ISO weekday ${isoWeekday(TODAY)})`);
  console.log(`[seed] history     ${toISO(HISTORY_START)} -> ${toISO(TODAY)}`);
  console.log(`[seed] habits      ${habits.length}`);
  console.log(`[seed] habit_logs  ${counts.logCount}`);
  console.log(`[seed] tasks       ${tasks.length}`);
  console.log(
    `[seed] journal     ${Object.keys(dayEntries).length} day + ${monthEntries.length} month`,
  );
}

try {
  await seed();
} catch (error) {
  console.error(`[seed] ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
