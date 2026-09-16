/**
 * The API's payloads, by hand.
 *
 * Written against server/src/modules/**, not generated: there is no OpenAPI
 * document to generate from, and the shapes are stable. Two distinctions here
 * are load-bearing and easy to lose:
 *
 *   - Ids are bigint in Postgres and arrive as STRINGS. Never Number() one.
 *   - `schedule_kind` means two different things depending on where it appears.
 *     See ScheduleKind and EffectiveKind below.
 */

/** A habit, task or journal id. Always a string — see the note above. */
export type Id = string;
/** A calendar day, "YYYY-MM-DD". These compare correctly with < and <=. */
export type IsoDate = string;
/** "YYYY-MM". */
export type IsoMonth = string;

/** habits.color_token — a theme token, never a hex value. */
export type ColorToken = "chart-1" | "chart-2" | "chart-3" | "chart-4" | "chart-5";

/**
 * What a schedule version stores. Pausing is a schedule, not a separate
 * mechanism, which is why a break reads as absence rather than failure.
 */
export type ScheduleKind = "fixed" | "weekly" | "paused";

/**
 * What the read models (/day, /grid, /review) report. effectiveKind() skips
 * paused versions deliberately, so "paused" can never appear here — a paused
 * habit still reports the kind it will resume as.
 */
export type EffectiveKind = "fixed" | "weekly";

/** The three things a person can claim about a day. No row at all is a fourth. */
export type LogStatus = "done" | "missed" | "skipped";

/** Every state one day can be in for one habit. See lib/scheduling.js. */
export type Verdict =
  | "inactive"
  | "paused"
  | "unscheduled"
  | "bonus"
  | "done"
  | "skipped"
  | "missed"
  | "unlogged"
  | "future";

/** ISO-8601 weekday: 1 = Monday ... 7 = Sunday, matching Postgres ISODOW. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface Schedule {
  effective_from: IsoDate;
  schedule_kind: ScheduleKind;
  /** Set only when schedule_kind is "fixed". */
  schedule_days: Weekday[] | null;
  /** Set only when schedule_kind is "weekly". */
  weekly_target: number | null;
  /**
   * The amount asked for on one occasion, in the habit's `unit`. Null in three
   * different situations and they are not the same: the habit is binary, the
   * habit is measured but aims at nothing, or this version is a pause — a pause
   * asks for nothing at all.
   *
   * TRAP: unrelated to `weekly_target`, despite the name. That one counts
   * occasions and this one measures each of them: three times a week, five
   * kilometres each. They can both be set on the same version.
   */
  target_value: number | null;
}

/** The schedule half of a create or change request. */
export type ScheduleInput =
  | { schedule_kind: "fixed"; schedule_days: Weekday[]; target_value?: number | null }
  | { schedule_kind: "weekly"; weekly_target: number; target_value?: number | null }
  // No target: the server's paused branch does not accept one and would drop it.
  | { schedule_kind: "paused" };

/**
 * What a paused habit will resume to: its latest version that actually asked
 * for something. Never itself paused, so `schedule_kind` here is only ever
 * "fixed" or "weekly", and null when nothing was ever asked.
 *
 * It is on the payload because the client cannot derive it. A paused version
 * stores no days and no target, so without this the interface has to invent a
 * schedule to resume on — and inventing one silently rewrites the habit.
 */
export type ResumeSchedule = Schedule | null;

/** GET /api/habits — `schedule` is resolved as of today, not a version history. */
export interface Habit {
  id: Id;
  name: string;
  color_token: ColorToken;
  sort_order: number;
  start_date: IsoDate;
  archived_on: IsoDate | null;
  /**
   * The measured unit ("km", "pages", "reps"), or null.
   *
   * NOT NULL is the only marker that a habit is measured at all — never the
   * target, which lives on the schedule version and is absent during a pause.
   * A paused quantity habit is still a quantity habit.
   */
  unit: string | null;
  /**
   * Whether the unit can still be changed. The server's answer, and not
   * derivable here: it depends on whether any log in the habit's whole history
   * carries a value. Never compute a substitute — the server refuses the change
   * either way, and a guess would either offer a field that cannot save or hide
   * one that could.
   */
  unit_locked: boolean;
  schedule: Schedule | null;
  /** Set only while `schedule.schedule_kind` is "paused". */
  resumes_to: ResumeSchedule;
  /**
   * The nearest version dated after today, or null. `schedule` above stays the
   * one in force now — these are reported side by side, never one instead of
   * the other, because a change that has been decided and a change that is in
   * force are different claims.
   */
  next_schedule: Schedule | null;
}

/**
 * One written day of one habit. `note` is never null here — the query that
 * returns these asks only for rows that have one.
 */
export interface HistoryNote {
  date: IsoDate;
  status: LogStatus;
  value: number | null;
  note: string;
}

/**
 * GET /api/habits/:id/history — one habit's whole life.
 *
 * `cells` is the same nine-verdict encoding the grid uses (decode it with CELL
 * in features/habits/verdict.ts), running whole Monday-to-Sunday weeks from the
 * habit's start to the last day it was alive for.
 *
 * `versions` is every schedule this habit has ever had, oldest first. That is a
 * fact about the habit, not a reading of it — the append-only history is what
 * lets a past week keep the meaning it was lived under.
 *
 * Deliberately absent, and to stay absent: a longest streak, a best month, a
 * record of any kind. A count says what happened; a maximum is a high score in
 * a game with one player, and a screen carrying one turns "do not break the
 * record" into a reason not to rest.
 */
export interface HistoryPayload {
  habit: Habit;
  /** The server's today, in APP_TIMEZONE. Never use the browser's clock. */
  today: IsoDate;
  start: IsoDate;
  end: IsoDate;
  weeks: number;
  cells: string;
  versions: Schedule[];
  /** One page, newest first. */
  notes: HistoryNote[];
  /** The cursor for the page before this one, or null at the end of the record. */
  next_before: IsoDate | null;
}

export interface Task {
  id: Id;
  title: string;
  due_date: IsoDate | null;
  completed: boolean;
  completed_at: string | null;
  created_at: string;
  archived_at: string | null;
  /**
   * The calendar day `archived_at` fell on, in APP_TIMEZONE — present only on
   * `?scope=archived`, which is the only list that shows it and the only one
   * whose rows are archived at all.
   *
   * It exists because the client cannot derive it: `archived_at` is an instant
   * whose ISO string is UTC, so slicing the date off it is a different day from
   * the app's own for anyone not living on Greenwich.
   */
  archived_on?: IsoDate;
}

/** GET /api/tasks — every scope answers with this shape. */
export interface TasksPayload {
  tasks: Task[];
  /**
   * The server's today, in APP_TIMEZONE. As on DayPayload: never use the
   * browser's clock to decide whether a due date has passed.
   */
  today: IsoDate;
}

export interface JournalEntry {
  date: IsoDate;
  kind: "day" | "month";
  entry: string;
  updated_at: string;
}

/** Progress toward a weekly habit's target. null when the week is not scored. */
export interface WeekProgress {
  done: number;
  target: number;
  met: boolean;
}

export interface DayHabit {
  id: Id;
  name: string;
  color_token: ColorToken;
  schedule_kind: EffectiveKind;
  /**
   * TRAP: true only for a fixed habit whose weekday is named today. A weekly
   * habit — and a paused one — always reports false. Anything that decides
   * "is this actionable today" from this field alone hides every weekly habit,
   * every day. Use isActionable() in features/habits/verdict.ts.
   */
  scheduled: boolean;
  /**
   * Whether the schedule in force on this date is a paused one — a fact about
   * the habit, not about the day.
   *
   * TRAP: this is NOT `verdict === "paused"`, and never was. A paused day that
   * was worked reports verdict "bonus", so reading paused-ness off the verdict
   * loses it exactly when the habit was ticked.
   */
  paused: boolean;
  /** Set only while `paused`. See ResumeSchedule. */
  resumes_to: ResumeSchedule;
  /** The habit's unit, or null for a binary habit. See Habit.unit. */
  unit: string | null;
  /**
   * The target in force on THIS day, not today's — so a day lived under a 5 km
   * target keeps saying 5 after the target becomes 10. Null means nothing was
   * being aimed at on this day, which a paused day always is.
   */
  target_value: number | null;
  /**
   * What was measured. Null on a done day is a real answer — done, and not
   * measured — and never means the log is incomplete.
   */
  value: number | null;
  status: LogStatus | null;
  note: string | null;
  verdict: Verdict;
  /** As it stood at the end of the day being viewed, not necessarily today. */
  streak: number;
  week: WeekProgress | null;
}

export interface DayPayload {
  date: IsoDate;
  /** The server's today, in APP_TIMEZONE. Never use the browser's clock. */
  today: IsoDate;
  habits: DayHabit[];
  /** Only tasks WITH a due date appear here. */
  tasks: { due: Task[]; overdue: Task[] };
  journal: JournalEntry | null;
}

export interface Session {
  authenticated: true;
  expiresAt: string;
}

/** One week column of a weekly habit's grid row. `target` is null when the week was never scored. */
export interface GridWeek {
  start: IsoDate;
  done: number;
  target: number | null;
  met: boolean;
}

export interface GridHabit {
  id: Id;
  name: string;
  color_token: ColorToken;
  schedule_kind: EffectiveKind;
  /**
   * Set once the habit was archived. Its cells stay — the grid is a record —
   * but a row that stops dead with nothing to explain it reads as abandonment.
   */
  archived_on: IsoDate | null;
  /**
   * `weeks * 7` characters, one per day from `start`, Monday first. A day is a
   * character rather than an object because a year row is then 364 bytes and
   * not 364 objects — decode it with CELL in features/habits/verdict.ts.
   */
  cells: string;
  /** One entry per week column — weekly habits only, null for a fixed one. */
  weeks: GridWeek[] | null;
}

/** GET /api/grid — always whole Monday-to-Sunday weeks, so cells index by offset. */
export interface GridPayload {
  start: IsoDate;
  end: IsoDate;
  weeks: number;
  /** The server's today, in APP_TIMEZONE. Never use the browser's clock. */
  today: IsoDate;
  habits: GridHabit[];
}

/**
 * One habit's month. The six tallies are verdict counts over the month's days;
 * `consistency` is the server's own rate and the only scored value here.
 */
export interface ReviewHabit {
  id: Id;
  name: string;
  color_token: ColorToken;
  schedule_kind: EffectiveKind;
  /**
   * TRAP: compare this against the month's `end`, never against today. A habit
   * archived after the month shown was alive for all of it, and that month has
   * to keep reading the way it was lived — only `archived_on <= end` means the
   * habit retired within, or before, the month on screen.
   */
  archived_on: IsoDate | null;
  done: number;
  missed: number;
  skipped: number;
  unlogged: number;
  paused: number;
  bonus: number;
  /** The habit's unit, or null for a binary habit. See Habit.unit. */
  unit: string | null;
  /**
   * 0..1, or null when nothing was ever asked — which is not the same as
   * nothing being done, so it must never render as 0%.
   */
  consistency: number | null;
  /**
   * TRAP: the denominator `consistency` was computed against, NOT the partner
   * of `done`. A weekly habit reports done=4 alongside done_of=3. Never render
   * it, and never pair the two into "4 of 3".
   */
  done_of: number;
  /**
   * Both streaks are measured to the end of the window the review loaded, which
   * is the earlier of the month's last day and today. So for the current month
   * they are as of today, and for a past month they are as they stood when that
   * month ended — the streak that month finished on, not the one running now.
   *
   * That is the server capping the walk at `through` (see lastDay() in
   * lib/streaks.js), not an accident: a windowed read that measured to today
   * would walk over days it never loaded and report a broken streak.
   */
  /**
   * How close the measured sessions came to the target, 0..1, and how many of
   * them there were.
   *
   * A different question from `consistency`, and never a substitute for it:
   * consistency asks whether you showed up as often as you said you would, this
   * asks how close you got when you did. A habit can honestly be 100% on one and
   * 60% on the other, and both belong on screen.
   *
   * TRAP: `attainment_of` is the number of measured sessions, not the number of
   * done days — a done day with no value is a full occurrence and not a sample.
   * A rate over two sessions and a rate over twenty are different claims, so
   * never show the percentage without it.
   *
   * Null on every binary habit, and on a quantity habit whose sessions were
   * never measured. Null is not zero and must not render as 0%.
   */
  attainment: number | null;
  attainment_of: number;
  current_streak: number;
  /**
   * TRAP: on the payload, and never rendered — the same standing as `done_of`
   * above, for a different reason.
   *
   * The product may state what happened; it may not frame a history as records
   * to beat. A "best" is a high score in a game with one player, and a screen
   * carrying one makes resting cost something in an app whose scoring model
   * exists to make rest free. Counts, states and rates are facts and all stay;
   * a maximum is not one of them.
   *
   * It is still reported because the server computes it honestly and the export
   * is the user's data. Nothing in the interface reads it.
   */
  longest_streak: number;
}

/** GET /api/review/:month */
export interface ReviewPayload {
  month: IsoMonth;
  start: IsoDate;
  end: IsoDate;
  habits: ReviewHabit[];
  tasks: { completed: number; created: number };
  /** `month` is the reflection anchored to the 1st; `days` are that month's day notes. */
  journal: { month: JournalEntry | null; days: JournalEntry[] };
}
