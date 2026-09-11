/**
 * "Certain days" or "times a week" — the product's two ways of asking.
 *
 * Every control is a native radio or checkbox behind an sr-only input, so
 * grouping, arrow-key navigation and announcement come from the platform and
 * only the appearance is ours.
 */
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
  onChange,
}: {
  draft: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
}) {
  const toggleDay = (day: Weekday) => {
    if (draft.kind !== "fixed") return;
    const days = draft.days.includes(day)
      ? draft.days.filter((value) => value !== day)
      : [...draft.days, day].sort((a, b) => a - b);
    onChange({ kind: "fixed", days });
  };

  return (
    <fieldset>
      <legend className="text-meta text-muted pb-1.5">How often</legend>

      <div className="grid grid-cols-2 gap-2">
        <Choice
          type="radio"
          name="schedule-kind"
          checked={draft.kind === "fixed"}
          onChange={() => onChange({ kind: "fixed", days: EVERY_DAY })}
          label="Certain days of the week"
        >
          Certain days
        </Choice>
        <Choice
          type="radio"
          name="schedule-kind"
          checked={draft.kind === "weekly"}
          onChange={() => onChange({ kind: "weekly", target: 3 })}
          label="A number of times a week"
        >
          Times a week
        </Choice>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-1.5">
        {draft.kind === "fixed"
          ? WEEKDAYS.map(({ day, short, full }) => (
              <Choice
                key={day}
                type="checkbox"
                name={`day-${day}`}
                checked={draft.days.includes(day)}
                onChange={() => toggleDay(day)}
                label={full}
                className="text-meta px-0"
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
                onChange={() => onChange({ kind: "weekly", target: count })}
                label={count === 1 ? "Once a week" : `${count} times a week`}
                className="px-0"
              >
                {count}
              </Choice>
            ))}
      </div>

      <p className="text-meta text-muted mt-2">
        {draft.kind === "fixed"
          ? draft.days.length === 0
            ? "Pick at least one day."
            : "Missing one of these days counts against the streak."
          : "Any days you like, as long as the week adds up."}
      </p>
    </fieldset>
  );
}
