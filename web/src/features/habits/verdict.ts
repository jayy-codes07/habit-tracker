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
import type { CSSProperties } from "react";

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
 * The word for the mark drawn on the row — the key, said where the symbol is.
 *
 * A row's state was legible only as geometry: a filled square, a hollow warm
 * one, a diamond, a gap in the rule. That is a vocabulary to be learnt before
 * the screen can be read, and nobody learns a vocabulary from a tracker. Only a
 * screen reader was ever told in words (see stateLabel).
 *
 * Null where the line beneath already says it: `extra` is spelt out as "Extra,
 * not scheduled", and an open day that has not been logged yet is not a state
 * to announce — the dashed target says there is something to hit.
 */
function markWord(habit: DayHabit): string | null {
  switch (markOf(habit)) {
    case "done":
      return "Done";
    case "skipped":
      return "Skipped";
    case "missed":
      return "Missed";
    case "open":
      return habit.verdict === "unlogged" ? "Not logged" : null;
    default:
      return null;
  }
}

/**
 * The quiet second line: what the mark is, then the single other fact that
 * matters most for this habit on this day. Not a list of everything known about
 * it — a weekly habit's streak is a real number, but its week's progress is the
 * one that changes behaviour.
 */
export function metaLine(habit: DayHabit): string | null {
  if (habit.verdict === "inactive") return "Not started yet";
  // `paused`, not the verdict: a paused day that was worked reports "bonus", and
  // reading the verdict here left a paused habit describing its week instead.
  if (habit.paused) return "Paused";

  const parts = [markWord(habit)];

  if (habit.schedule_kind === "weekly") {
    if (!habit.week) parts.push("No target this week");
    else if (habit.week.met) parts.push("Weekly target met");
    else parts.push(`${habit.week.done} of ${habit.week.target} this week`);
  } else if (!habit.scheduled) {
    // "Extra" alone does not say what was extra about it; a day worked when
    // nothing was asked is worth naming plainly.
    parts.push(habit.status === "done" ? "Extra, not scheduled" : "Rest day");
  } else if (habit.streak > 0) {
    parts.push(`${habit.streak} day streak`);
  }

  const line = parts.filter(Boolean).join(" · ");
  return line === "" ? null : line;
}

/**
 * What was measured today, for the row — "3 of 5 km", or "3 km" when the habit
 * aims at nothing.
 *
 * Null whenever there is nothing measured to say, which includes every binary
 * habit and every day that was done without being measured. Deliberately
 * separate from metaLine: the meta line carries the single most important fact
 * about the day, and a number is an additional one rather than a replacement —
 * a weekly habit still needs to say where its week stands.
 */
export function amountLine(habit: DayHabit): string | null {
  if (!habit.unit || habit.value === null) return null;
  return habit.target_value === null
    ? `${habit.value} ${habit.unit}`
    : `${habit.value} of ${habit.target_value} ${habit.unit}`;
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

/**
 * The schedule, in the words a person would use.
 *
 * `amount` and `unit` are the measured target, and they are appended rather than
 * folded in: "Mon, Wed, Fri · 5 km" says the two separate things the schedule
 * actually holds — which days, and how much each time. A pause says nothing
 * about either, because it asks for neither.
 */
export function scheduleWords(
  kind: "fixed" | "weekly" | "paused",
  days: number[] | null,
  target: number | null,
  amount: number | null = null,
  unit: string | null = null,
): string {
  if (kind === "paused") return "Paused";

  const often =
    kind === "weekly"
      ? target === 1
        ? "Once a week"
        : `${target} times a week`
      : everyWords(days);

  // Both halves or neither: an amount with no unit is a number meaning nothing,
  // and the server cannot store one anyway.
  return amount !== null && unit ? `${often} · ${amount} ${unit}` : often;
}

function everyWords(days: number[] | null): string {
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

/**
 * How the PAPER runs under one day of one channel.
 *
 * The drum is pre-ruled and the data is ink laid on top, so half the nine-state
 * vocabulary is carried by the ruling rather than by anything drawn in the
 * cell. Four treatments:
 *
 *   "none"  the habit did not exist — no paper at all
 *   "dim"   ahead of the pen: blank paper, drawn at 38%
 *   "peck"  paused — the ruling itself goes pecked across the span
 *   "on"    a day the habit was alive and being asked of
 *
 * This is what lets `paused` and `unscheduled` stop being the same square. They
 * were identical in the grid until now and the difference survived only in a
 * tooltip; a pecked rule says it on the paper.
 *
 * Sheet.tsx groups consecutive days of the same treatment into ONE rule per
 * run, which is why this answers per day and says nothing about geometry.
 */
export type Paper = "none" | "dim" | "peck" | "on";

export function paperOf(verdict: Verdict): Paper {
  switch (verdict) {
    case "inactive":
      return "none";
    case "future":
      return "dim";
    case "paused":
      return "peck";
    default:
      return "on";
  }
}

/**
 * The INK for one day of one habit. The single implementation — Sheet.tsx is
 * its only caller, and Sheet is what both the grid and a habit's history draw
 * with, so the two screens cannot quietly stop agreeing.
 *
 * Five of the nine verdicts return nothing at all, and that is the design: a
 * rest day, a paused day, a future day and a day before the habit existed have
 * no ink, and are told apart by the paper under them (see paperOf). What is
 * left is four marks, and every distinction between them is SHAPE:
 *
 *   done      a filled square
 *   bonus     the same square at 42% — lighter, and it survives greyscale
 *   missed    a SOLID hollow ring
 *   unlogged  a DOTTED hollow ring
 *
 * plus `skipped`, whose mark is markup rather than style — SkipMark in
 * marks.tsx, because this file holds no JSX. A skipped day is bare paper with a
 * dash across it, which reads at 11px because the dash now sits on the canvas
 * rather than on a tray: --c-muted is 7:1 here against 2.4:1 before.
 *
 * Hue is the habit's identity and never the day's verdict. --c-warn appears on
 * exactly one state, which is also hollow and also solid-versus-dotted, so
 * colour is the third signal it carries and never the first. The whole
 * vocabulary is verified in greyscale, in both themes, at the 11px cell by
 * tests/state-vocabulary — an actual render of this function, not a mock-up.
 */
export function paint(verdict: Verdict, tint: string): CSSProperties {
  switch (verdict) {
    case "done":
      return { background: tint };
    case "bonus":
      return { background: `color-mix(in srgb, ${tint} 42%, transparent)` };
    case "missed":
      return { boxShadow: "inset 0 0 0 1.5px var(--c-warn)" };
    case "unlogged":
      return {
        outline: "1.5px dotted var(--c-baseline)",
        outlineOffset: "-1.5px",
      };
    // done/bonus/missed/unlogged are ink; everything else is paper.
    default:
      return {};
  }
}

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
