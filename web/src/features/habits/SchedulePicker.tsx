/**
 * "Certain days" or "times a week" — the product's two ways of asking.
 *
 * Every control is a native radio or checkbox behind an sr-only input, so
 * grouping, arrow-key navigation and announcement come from the platform and
 * only the appearance is ours.
 */
import { AmountField } from "./AmountField";
import { Choice } from "../../components/Choice";
import { EVERY_DAY, type ScheduleDraft } from "./schedule";
import type { Weekday } from "../../types";

const WEEKDAYS: { day: Weekday; short: string; full: string }[] = [
  { day: 1, short: "Mo", full: "Monday" },
  { day: 2, short: "Tu", full: "Tuesday" },
  { day: 3, short: "We", full: "Wednesday" },
  { day: 4, short: "Th", full: "Thursday" },
  { day: 5, short: "Fr", full: "Friday" },
  { day: 6, short: "Sa", full: "Saturday" },
  { day: 7, short: "Su", full: "Sunday" },
];

export function SchedulePicker({
  draft,
  unit,
  onChange,
}: {
  draft: ScheduleDraft;
  /**
   * The habit's unit, or null for a binary habit. The target box exists only
   * when there is something to count in — a target with no unit is a number
   * that means nothing, and the server refuses to store one.
   */
  unit: string | null;
  onChange: (next: ScheduleDraft) => void;
}) {
  const toggleDay = (day: Weekday) => {
    if (draft.kind !== "fixed") return;
    const days = draft.days.includes(day)
      ? draft.days.filter((value) => value !== day)
      : [...draft.days, day].sort((a, b) => a - b);
    onChange({ ...draft, kind: "fixed", days });
  };

  return (
    <fieldset>
      <legend className="label text-muted pb-2.5">How often</legend>

      <div className="flex">
        <Choice
          type="radio"
          name="schedule-kind"
          checked={draft.kind === "fixed"}
          onChange={() => onChange({ kind: "fixed", days: EVERY_DAY, amount: draft.amount })}
          label="Certain days of the week"
        >
          Certain days
        </Choice>
        <Choice
          type="radio"
          name="schedule-kind"
          checked={draft.kind === "weekly"}
          onChange={() => onChange({ kind: "weekly", target: 3, amount: draft.amount })}
          label="A number of times a week"
        >
          Times a week
        </Choice>
      </div>

      <div className="mt-5 flex">
        {draft.kind === "fixed"
          ? WEEKDAYS.map(({ day, short, full }) => (
              <Choice
                key={day}
                type="checkbox"
                name={`day-${day}`}
                checked={draft.days.includes(day)}
                onChange={() => toggleDay(day)}
                label={full}
                className="px-0"
              >
                {short}
              </Choice>
            ))
          : EVERY_DAY.map((count) => (
              <Choice
                key={count}
                type="radio"
                name="weekly-target"
                checked={draft.target === count}
                onChange={() => onChange({ kind: "weekly", target: count, amount: draft.amount })}
                label={count === 1 ? "Once a week" : `${count} times a week`}
                className="px-0"
              >
                {count}
              </Choice>
            ))}
      </div>

      <p className="text-meta text-muted mt-3">
        {draft.kind === "fixed"
          ? draft.days.length === 0
            ? "Pick at least one day."
            : "Missing one of these days counts against the streak."
          : "Any days you like, as long as the week adds up."}
      </p>

      {/*
       * Optional, and said so plainly. A measured habit is allowed to aim at
       * nothing — recording how far you ran without committing to a distance is
       * a real way to use this — so an empty box is an answer, not a gap.
       *
       * It never appears on a pause, because a pause asks for nothing at all:
       * HabitEditor disables the whole fieldset while Paused is ticked, and the
       * server's paused body carries no target to send.
       */}
      {unit !== null && (
        <div className="mt-4">
          <AmountField
            id="schedule-target"
            label="Target each time (optional)"
            unit={unit}
            value={draft.amount}
            placeholder="No target"
            hint="Missing it never breaks a streak. It is only how close you got, reported on its own."
            onCommit={(amount) => onChange({ ...draft, amount })}
          />
        </div>
      )}
    </fieldset>
  );
}
