import { useRef, useState } from "react";

import { AmountField } from "./AmountField";
import { Choice } from "../../components/Choice";
import { Dialog } from "../../components/Dialog";
import { FIELD, PRIMARY, QUIET } from "../../components/form";
import { SchedulePicker } from "./SchedulePicker";
import { draftOf, isDraftValid, toScheduleInput } from "./schedule";
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
  /*
   * Held here as well as on the server so that choosing a status carries the
   * number the person has already typed. PUT replaces the whole log row, so a
   * status written without it would clear a measurement entered a second
   * earlier — the same trap the note already avoids.
   */
  const [value, setValue] = useState(habit.value);
  // The version the pause interrupted, from the server. The old guess read the
  // target off `week`, which a paused week never scores, so every weekly habit
  // resumed at three a week whatever it had been.
  const [draft, setDraft] = useState(draftOf(habit.resumes_to));

  const setLog = useSetLog(date);
  const schedule = useSetSchedule();

  /*
   * The note saves on blur, and closing the sheet is not a blur.
   *
   * Escape and a tap on the backdrop fire the dialog's own close, which
   * unmounts this component — so a note typed and then dismissed was written,
   * looked saved, and was gone. Every exit now goes through close(), and the
   * ref is what stops the blur that a tap on the X button fires first from
   * writing the same sentence twice.
   */
  const written = useRef(habit.note ?? "");

  const saveNote = () => {
    const next = note.trim();
    if (!habit.status || next === written.current) return;
    written.current = next;
    setLog.mutate({ habit, status: habit.status, note: next || null, value });
  };

  const close = () => {
    saveNote();
    onClose();
  };

  // Not `verdict === "paused"`: a paused day that was worked reports "bonus",
  // so that test lost the pause exactly when the habit had been ticked — the
  // sheet then offered "Pause" on an already-paused habit and no way back.
  const paused = habit.paused;
  const error = setLog.error ?? schedule.error;

  if (mode === "resume") {
    return (
      <Dialog open onClose={close} title={`Resume ${habit.name}`}>
        <div className="grid gap-5">
          <p className="text-muted -mt-2">
            This takes effect today. Past weeks keep the schedule they were lived under.
          </p>
          <SchedulePicker draft={draft} unit={habit.unit} onChange={setDraft} />
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
                  { onSuccess: close },
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
    <Dialog open onClose={close} title={habit.name}>
      <div className="grid gap-5">
        {meta && <p className="text-muted -mt-2">{meta}</p>}

        <fieldset disabled={readOnly}>
          <legend className="label text-muted pb-2.5">
            {readOnly ? "This day has not happened yet" : "How did it go?"}
          </legend>
          <div className="grid grid-cols-4 gap-2">
            {STATES.map(({ status, label }) => (
              <Choice
                key={status}
                type="radio"
                name="log-status"
                checked={habit.status === status}
                onChange={() => {
                  // Recorded as written, so close() does not send the same
                  // sentence a second time on the way out.
                  written.current = note.trim();
                  setLog.mutate({
                    habit,
                    status,
                    note: note.trim() || null,
                    // Done cannot measure zero, so a zero already in the box is
                    // dropped rather than rejected: the person asked for the
                    // day to be done, and an unmeasured done day is valid.
                    value: status === "done" && value === 0 ? null : value,
                  });
                }}
                label={label}
                className=""
              >
                {label}
              </Choice>
            ))}
            <button
              type="button"
              disabled={habit.status === null || readOnly}
              onClick={() => {
                setNote("");
                written.current = "";
                setValue(null);
                setLog.mutate({ habit, status: null });
              }}
              className="label text-muted hover:text-ink min-h-11 underline decoration-[var(--c-baseline)] underline-offset-[6px] disabled:opacity-40"
            >
              Clear
            </button>
          </div>
        </fieldset>

        {/*
         * Measured habits only — `unit` is the whole marker, so a binary habit
         * never sees a box for a number it has nowhere to put. Keyed on the
         * habit and its stored value so that a correction arriving from the
         * server restarts the field rather than fighting what is in it.
         */}
        {habit.unit && (
          <AmountField
            key={`${habit.id}-${habit.value ?? ""}`}
            id="log-value"
            label="How much"
            unit={habit.unit}
            value={value}
            disabled={habit.status === null || readOnly}
            // Zero is a real measurement on a day you missed or skipped, and a
            // contradiction on one you call done.
            allowZero={habit.status !== "done"}
            placeholder={
              habit.status === null
                ? "Mark the day first."
                : habit.target_value !== null
                  ? String(habit.target_value)
                  : "Not measured"
            }
            hint={
              habit.target_value === null
                ? "No target set. This is recorded as it is."
                : `Target ${habit.target_value} ${habit.unit}. Falling short never breaks a streak.`
            }
            onCommit={(next) => {
              setValue(next);
              if (habit.status) {
                written.current = note.trim();
                setLog.mutate({
                  habit,
                  status: habit.status,
                  note: note.trim() || null,
                  value: next,
                });
              }
            }}
          />
        )}

        <div>
          <label htmlFor="log-note" className="label text-muted block pb-2.5">
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
            onBlur={saveNote}
            className={`${FIELD} min-h-24 resize-y py-2.5 font-serif disabled:opacity-50`}
          />
        </div>

        {error && (
          <p role="alert" className="text-warn text-meta">
            {(error as Error).message}
          </p>
        )}

        <div className="border-grid grid gap-2 border-t pt-4">
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
                    { onSuccess: close },
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
