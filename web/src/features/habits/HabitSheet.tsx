import { useState } from "react";

import { Choice } from "../../components/Choice";
import { Dialog } from "../../components/Dialog";
import { FIELD, PRIMARY, QUIET } from "../../components/form";
import { SchedulePicker } from "./SchedulePicker";
import { EVERY_DAY, isDraftValid, toScheduleInput, type ScheduleDraft } from "./schedule";
import { useSetLog, useSetSchedule } from "./queries";
import { metaLine } from "./verdict";
import type { DayHabit, IsoDate } from "../../types";

const STATES = [
  { status: "done", label: "Done" },
  { status: "skipped", label: "Skipped" },
  { status: "missed", label: "Missed" },
] as const;

/**
 * Everything you can say about one habit on one day, plus the one thing you can
 * say about the habit itself from here: pause it.
 *
 * A note cannot exist without a status — the log row is what carries it — so
 * the field says so rather than failing on save.
 *
 * Mounted only while a habit is selected, so its state starts fresh for each
 * one and nothing has to be reset between openings.
 */
export function HabitSheet({
  habit,
  date,
  readOnly,
  onClose,
}: {
  habit: DayHabit;
  date: IsoDate;
  readOnly: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"actions" | "resume">("actions");
  const [note, setNote] = useState(habit.note ?? "");
  const [draft, setDraft] = useState<ScheduleDraft>(
    habit.schedule_kind === "weekly"
      ? { kind: "weekly", target: habit.week?.target ?? 3 }
      : { kind: "fixed", days: EVERY_DAY },
  );

  const setLog = useSetLog(date);
  const schedule = useSetSchedule();

  const paused = habit.verdict === "paused";
  const error = setLog.error ?? schedule.error;

  if (mode === "resume") {
    return (
      <Dialog open onClose={onClose} title={`Resume ${habit.name}`}>
        <div className="grid gap-5">
          <p className="text-muted -mt-2">
            This takes effect today. Past weeks keep the schedule they were lived under.
          </p>
          <SchedulePicker draft={draft} onChange={setDraft} />
          {error && (
            <p role="alert" className="text-warn text-meta">
              {(error as Error).message}
            </p>
          )}
          <div className="grid gap-2">
            <button
              type="button"
              className={PRIMARY}
              disabled={!isDraftValid(draft) || schedule.isPending}
              onClick={() =>
                schedule.mutate(
                  { id: habit.id, schedule: toScheduleInput(draft) },
                  { onSuccess: onClose },
                )
              }
            >
              {schedule.isPending ? "Resuming…" : "Resume habit"}
            </button>
            <button type="button" className={QUIET} onClick={() => setMode("actions")}>
              Back
            </button>
          </div>
        </div>
      </Dialog>
    );
  }

  const meta = metaLine(habit);

  return (
    <Dialog open onClose={onClose} title={habit.name}>
      <div className="grid gap-5">
        {meta && <p className="text-muted -mt-2">{meta}</p>}

        <fieldset disabled={readOnly}>
          <legend className="text-meta text-muted pb-1.5">
            {readOnly ? "This day has not happened yet" : "How did it go?"}
          </legend>
          <div className="grid grid-cols-4 gap-2">
            {STATES.map(({ status, label }) => (
              <Choice
                key={status}
                type="radio"
                name="log-status"
                checked={habit.status === status}
                onChange={() => setLog.mutate({ habit, status, note: note.trim() || null })}
                label={label}
                className="text-meta px-0"
              >
                {label}
              </Choice>
            ))}
            <button
              type="button"
              disabled={habit.status === null || readOnly}
              onClick={() => {
                setNote("");
                setLog.mutate({ habit, status: null });
              }}
              className="border-line-strong hover:bg-raised text-meta text-muted hover:text-ink min-h-11 rounded-lg border disabled:opacity-40"
            >
              Clear
            </button>
          </div>
        </fieldset>

        <div>
          <label htmlFor="log-note" className="text-meta text-muted block pb-1.5">
            Note
          </label>
          <textarea
            id="log-note"
            value={note}
            rows={3}
            maxLength={1000}
            disabled={habit.status === null || readOnly}
            placeholder={
              habit.status === null ? "Mark the day first to add a note." : "How did it go?"
            }
            onChange={(event) => setNote(event.target.value)}
            onBlur={() => {
              if (habit.status && note.trim() !== (habit.note ?? "")) {
                setLog.mutate({ habit, status: habit.status, note: note.trim() || null });
              }
            }}
            className={`${FIELD} min-h-24 resize-y py-2.5 font-serif disabled:opacity-50`}
          />
        </div>

        {error && (
          <p role="alert" className="text-warn text-meta">
            {(error as Error).message}
          </p>
        )}

        <div className="border-line grid gap-2 border-t pt-4">
          {paused ? (
            <>
              <button type="button" className={QUIET} onClick={() => setMode("resume")}>
                Resume this habit
              </button>
              <p className="text-meta text-muted">
                Paused since the last schedule change. Nothing is being asked of you meanwhile.
              </p>
            </>
          ) : (
            <>
              <button
                type="button"
                className={QUIET}
                disabled={schedule.isPending}
                onClick={() =>
                  schedule.mutate(
                    { id: habit.id, schedule: { schedule_kind: "paused" } },
                    { onSuccess: onClose },
                  )
                }
              >
                {schedule.isPending ? "Pausing…" : "Pause this habit"}
              </button>
              <p className="text-meta text-muted">
                A pause reads as time off, not as failure: paused days stay out of your streak and
                out of your consistency.
              </p>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
