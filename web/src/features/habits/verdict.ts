/**
 * Turning the API's nine verdicts into something a person reads.
 *
 * The interface never says "verdict", "status", "fixed" or "weekly". It says
 * Done, Extra, Skipped, Missed, Not logged, Rest day and Paused — and for a
 * schedule, "certain days" or "times a week".
 *
 * The persisted status and the derived verdict are both needed and mean
 * different things: status is what the user claimed, verdict is what the day
 * amounted to given the schedule in force. A day done when nothing was asked is
 * status "done" and verdict "bonus", and the row has to show both facts.
 */
import type { DayHabit, Verdict } from "../../types";

/** How the control on a habit row is drawn. */
export type Mark = "done" | "extra" | "skipped" | "missed" | "open";

export function markOf(habit: DayHabit): Mark {
  if (habit.status === "done") return habit.verdict === "bonus" ? "extra" : "done";
  if (habit.status === "skipped") return "skipped";
  if (habit.status === "missed") return "missed";
  return "open";
}

/**
 * Whether this habit is something to act on today.
 *
 * `scheduled` is true only for a fixed habit whose weekday is named, so a
 * weekly habit always reports false and would vanish from the list if this
 * read that field alone. An already-logged habit stays actionable whatever the
 * schedule says, because a tick made by mistake has to be undoable.
 */
export function isActionable(habit: DayHabit): boolean {
  if (habit.verdict === "inactive") return false;
  if (habit.status !== null) return true;
  if (habit.paused) return false;
  return habit.schedule_kind === "weekly" || habit.scheduled;
}

/** What a screen reader hears after the habit's name. */
export function stateLabel(habit: DayHabit): string {
  switch (markOf(habit)) {
    case "done":
      return "done";
    case "extra":
      return "done, extra: it was not scheduled";
    case "skipped":
      return "skipped";
    case "missed":
      return "missed";
    default:
      return habit.verdict === "unlogged" ? "not logged" : "not done yet";
  }
}

/**
 * The quiet second line: the single fact that matters most for this habit on
 * this day. Not a list of everything known about it — a weekly habit's streak
 * is a real number, but its week's progress is the one that changes behaviour.
 */
export function metaLine(habit: DayHabit): string | null {
  if (habit.verdict === "inactive") return "Not started yet";
  // `paused`, not the verdict: a paused day that was worked reports "bonus", and
  // reading the verdict here left a paused habit describing its week instead.
  if (habit.paused) return "Paused";

  if (habit.schedule_kind === "weekly") {
    if (!habit.week) return "No target this week";
    if (habit.week.met) return "Weekly target met";
    return `${habit.week.done} of ${habit.week.target} this week`;
  }

  // "Extra" alone does not say what was extra about it; a day worked when
  // nothing was asked is worth naming plainly.
  if (!habit.scheduled) return habit.status === "done" ? "Extra, not scheduled" : "Rest day";
  if (habit.streak > 0) return `${habit.streak} day streak`;
  return null;
}

/**
 * How the day stands, counted only over habits that were actually asked for.
 *
 * A weekly habit counts as settled once its week's target is met, which is the
 * honest reading: there is nothing left to do for it, whatever today's row says.
 */
export function summarise(habits: DayHabit[]) {
  const actionable = habits.filter(isActionable);
  const met = (habit: DayHabit) => habit.schedule_kind === "weekly" && habit.week?.met === true;

  const done = actionable.filter((habit) => habit.status === "done" || met(habit)).length;
  const settled = actionable.filter((habit) => habit.status !== null || met(habit)).length;

  return { total: actionable.length, done, left: actionable.length - settled };
}

/** The schedule, in the words a person would use. */
export function scheduleWords(
  kind: "fixed" | "weekly" | "paused",
  days: number[] | null,
  target: number | null,
): string {
  if (kind === "paused") return "Paused";
  if (kind === "weekly") return target === 1 ? "Once a week" : `${target} times a week`;

  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const chosen = [...(days ?? [])].sort((a, b) => a - b);
  if (chosen.length === 7) return "Every day";
  if (chosen.length === 5 && chosen.every((day) => day <= 5)) return "Weekdays";
  if (chosen.length === 2 && chosen[0] === 6 && chosen[1] === 7) return "Weekends";
  return chosen.map((day) => names[day - 1]).join(", ");
}

/**
 * The grid packs each day into one character — server lib/scheduling.js
 * VERDICT_CHAR. Kept here rather than in the grid screen because it is the same
 * nine-verdict vocabulary the rest of this file translates, just encoded.
 */
export const CELL: Record<string, Verdict> = {
  "-": "inactive",
  p: "paused",
  ".": "unscheduled",
  b: "bonus",
  d: "done",
  s: "skipped",
  m: "missed",
  u: "unlogged",
  f: "future",
};

/** A verdict in the words the interface uses, for one day of one habit. */
export const VERDICT_LABEL: Record<Verdict, string> = {
  inactive: "Not tracked yet",
  paused: "Paused",
  unscheduled: "Rest day",
  bonus: "Extra",
  done: "Done",
  skipped: "Skipped",
  missed: "Missed",
  unlogged: "Not logged",
  future: "To come",
};

/** How many days of each verdict a grid row holds. A tally, never a rate — a rate is consistency, and that is the server's to compute. */
export function tally(cells: string): Partial<Record<Verdict, number>> {
  const counts: Partial<Record<Verdict, number>> = {};
  for (const char of cells) {
    const verdict = CELL[char];
    if (verdict) counts[verdict] = (counts[verdict] ?? 0) + 1;
  }
  return counts;
}
