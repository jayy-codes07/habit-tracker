/**
 * Everything you can say about a habit itself, as opposed to about one of its
 * days — which is what HabitSheet is for, on the Day screen.
 *
 * Two kinds of change live here and they are deliberately not the same thing:
 *
 *   - Name and colour are *corrections*. They apply to the habit's whole
 *     history, because they were always meant to read that way.
 *   - The schedule is a *decision*, dated. Saving one appends a version
 *     effective today; the versions behind it keep their meaning, so a week
 *     already lived is still scored under the rules it was lived under. The
 *     server refuses a backdated version outright, so the interface never
 *     offers one — it says what will happen instead.
 *
 * Pausing is that same mechanism, which is why it sits in the schedule section
 * and not in the destructive one: a pause is time off, not an ending.
 *
 * Mounted only while a habit is being edited, so its state starts fresh for
 * each one and nothing has to be reset between openings.
 */
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { FIELD, PRIMARY, QUIET } from "../../components/form";
import { ColorPicker } from "./ColorPicker";
import { SchedulePicker } from "./SchedulePicker";
import { draftOf, isDraftValid, matchesSchedule, toScheduleInput } from "./schedule";
import { useDeleteHabit, usePatchHabit, useSetSchedule } from "./queries";
import { ApiError } from "../../lib/api-client";
import { formatDateShort } from "../../lib/dates";
import type { ColorToken, Habit } from "../../types";

const DANGER =
  "border-warn text-warn hover:bg-warn/10 min-h-12 w-full rounded-lg border px-4 font-medium disabled:opacity-40";

export function HabitEditor({ habit, onClose }: { habit: Habit; onClose: () => void }) {
  const current = habit.schedule;
  const wasPaused = current?.schedule_kind === "paused";

  const [name, setName] = useState(habit.name);
  const [color, setColor] = useState<ColorToken>(habit.color_token);
  const [paused, setPaused] = useState(wasPaused);
  // While paused, `current` is the paused version and says nothing about days or
  // target — `resumes_to` is the version the pause interrupted, and is what
  // unticking Paused must restore. Guessing here turned Tue/Thu into every day.
  const [draft, setDraft] = useState(draftOf(wasPaused ? habit.resumes_to : current));
  const [confirmDelete, setConfirmDelete] = useState(false);

  const patch = usePatchHabit();
  const schedule = useSetSchedule();
  const remove = useDeleteHabit();

  const archivedOn = habit.archived_on;
  const trimmed = name.trim();

  const detailsChanged = trimmed !== habit.name || color !== habit.color_token;
  const scheduleChanged = paused ? !wasPaused : wasPaused || !matchesSchedule(current, draft);
  const changed = detailsChanged || scheduleChanged;

  const busy = patch.isPending || schedule.isPending || remove.isPending;

  // A failed save and a refused delete are reported in different places: an
  // explanation three sections above the button that caused it reads as if
  // something else went wrong.
  const saveError = patch.error ?? schedule.error;

  // 409 is the one error with a way out: the habit has history, so archiving is
  // what the person actually wanted. Offering the button is the whole reason
  // this case is singled out.
  const blockedByHistory = remove.error instanceof ApiError && remove.error.status === 409;

  /**
   * Two writes, in order, and only the ones that are needed. Sequential rather
   * than parallel so that a rejected name never lands alongside an accepted
   * schedule change — a half-saved habit is worse than an unsaved one.
   */
  async function save() {
    try {
      if (detailsChanged) {
        await patch.mutateAsync({
          id: habit.id,
          patch: {
            ...(trimmed !== habit.name ? { name: trimmed } : {}),
            ...(color !== habit.color_token ? { color_token: color } : {}),
          },
        });
      }
      if (scheduleChanged) {
        await schedule.mutateAsync({
          id: habit.id,
          schedule: paused ? { schedule_kind: "paused" } : toScheduleInput(draft),
        });
      }
      onClose();
    } catch {
      // Rendered from the mutation's own error state below.
    }
  }

  const setArchived = (next: boolean) =>
    patch.mutate({ id: habit.id, patch: { archived: next } }, { onSuccess: onClose });

  return (
    <Dialog open onClose={onClose} title={habit.name}>
      <div className="grid gap-5">
        <div>
          <label htmlFor="edit-name" className="text-meta text-muted block pb-1.5">
            Name
          </label>
          <input
            id="edit-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            className={FIELD}
          />
        </div>

        <ColorPicker value={color} onChange={setColor} />

        {/* Disabled natively rather than hidden, so a paused habit still shows
            the schedule the checkbox below will resume it on. Choice dims its
            own disabled controls — do not dim the fieldset as well. */}
        <fieldset disabled={paused}>
          <SchedulePicker draft={draft} onChange={setDraft} />
        </fieldset>

        <label className="border-line-strong flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2">
          <input
            type="checkbox"
            checked={paused}
            onChange={() => setPaused(!paused)}
            className="accent-ink h-4 w-4 shrink-0"
          />
          <span className="flex-1">Paused</span>
        </label>

        <p className="text-meta text-muted -mt-3">
          {paused
            ? "Nothing is being asked of you meanwhile: paused days stay out of your streak and out of your consistency. Untick to resume on the schedule above."
            : "A schedule change takes effect today. Past weeks keep the schedule they were lived under."}
        </p>

        {saveError && (
          <p role="alert" className="text-warn text-meta">
            {saveError.message}
          </p>
        )}

        <div className="grid gap-2">
          <button
            type="button"
            className={PRIMARY}
            disabled={!trimmed || !isDraftValid(draft) || !changed || busy}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : changed ? "Save changes" : "Saved"}
          </button>
          <button type="button" className={QUIET} onClick={onClose}>
            Cancel
          </button>
        </div>

        <div className="border-line grid gap-2 border-t pt-4">
          {archivedOn ? (
            <>
              <button
                type="button"
                className={QUIET}
                disabled={busy}
                onClick={() => setArchived(false)}
              >
                Restore this habit
              </button>
              <p className="text-meta text-muted">
                Archived {formatDateShort(archivedOn)}. Its history is intact and comes back with
                it.
              </p>
            </>
          ) : (
            <>
              <button
                type="button"
                className={QUIET}
                disabled={busy}
                onClick={() => setArchived(true)}
              >
                Archive this habit
              </button>
              <p className="text-meta text-muted">
                Archiving keeps every day you logged and takes the habit off your list. You can
                restore it later.
              </p>
            </>
          )}

          {confirmDelete ? (
            <div className="mt-2 grid gap-2">
              {/* Once the server has refused, the question is settled — asking
                  it again under the answer would only invite a second tap on a
                  button that cannot work. */}
              {blockedByHistory ? (
                <>
                  <p role="alert" className="text-warn text-meta">
                    {remove.error?.message}
                  </p>
                  <button
                    type="button"
                    className={QUIET}
                    disabled={busy}
                    onClick={() => setArchived(true)}
                  >
                    Archive it instead
                  </button>
                </>
              ) : (
                <>
                  <p className="text-meta">
                    Delete {habit.name} for good? This cannot be undone, and a habit with logged
                    days cannot be deleted at all.
                  </p>
                  {remove.error && (
                    <p role="alert" className="text-warn text-meta">
                      {remove.error.message}
                    </p>
                  )}
                  <button
                    type="button"
                    className={DANGER}
                    disabled={busy}
                    onClick={() => remove.mutate(habit.id, { onSuccess: onClose })}
                  >
                    {remove.isPending ? "Deleting…" : "Delete permanently"}
                  </button>
                </>
              )}
              <button
                type="button"
                className={QUIET}
                onClick={() => {
                  remove.reset();
                  setConfirmDelete(false);
                }}
              >
                Keep it
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="text-warn text-meta mt-1 min-h-11 font-medium"
              onClick={() => setConfirmDelete(true)}
            >
              Delete this habit
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
