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
import { draftFor, draftOf, isDraftValid, matchesSchedule, toScheduleInput } from "./schedule";
import { useDeleteHabit, usePatchHabit, useSetSchedule } from "./queries";
import { scheduleWords } from "./verdict";
import { ApiError } from "../../lib/api-client";
import { formatDateLong, formatDateShort } from "../../lib/dates";
import type { ColorToken, Habit, Schedule } from "../../types";

const DANGER =
  "border-warn text-warn hover:bg-warn/10 min-h-12 w-full border px-4 font-medium disabled:opacity-40";

export function HabitEditor({ habit, onClose }: { habit: Habit; onClose: () => void }) {
  const current = habit.schedule;
  const wasPaused = current?.schedule_kind === "paused";

  const [name, setName] = useState(habit.name);
  const [color, setColor] = useState<ColorToken>(habit.color_token);
  const [unit, setUnit] = useState(habit.unit ?? "");
  const [paused, setPaused] = useState(wasPaused);
  // While paused, `current` is the paused version and says nothing about days or
  // target — `resumes_to` is the version the pause interrupted, and is what
  // unticking Paused must restore. Guessing here turned Tue/Thu into every day.
  const [draft, setDraft] = useState(draftOf(wasPaused ? habit.resumes_to : current));
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The version the server actually stored, held only when it dated it forward.
  const [saved, setSaved] = useState<Schedule | null>(null);

  const patch = usePatchHabit();
  const schedule = useSetSchedule();
  const remove = useDeleteHabit();

  const archivedOn = habit.archived_on;
  const trimmed = name.trim();

  /*
   * The server's answer, never a guess. Whether the unit is still changeable
   * depends on whether any log in the habit's whole history carries a value,
   * which this screen has no way to know — and the server refuses the change
   * regardless, so a wrong guess here would either offer a field that cannot
   * save or hide one that could.
   */
  const unitLocked = habit.unit_locked;
  const trimmedUnit = unit.trim();
  const nextUnit = trimmedUnit === "" ? null : trimmedUnit;
  const unitChanged = !unitLocked && nextUnit !== habit.unit;

  /*
   * Everything below reads the schedule as it will be saved, which depends on
   * the unit *being typed* rather than the one last stored: deleting the unit
   * takes the target with it, and typing one makes a target possible at once.
   * Nothing here is a second source of truth — the draft is still the draft,
   * and this only refuses to carry an amount the habit could not express.
   */
  const saving = draftFor(draft, nextUnit);
  /*
   * ...and it is compared against what the current version will say once that
   * unit change lands, because clearing the unit clears its target in the same
   * statement on the server. Without this, dropping the unit would also read as
   * a schedule change and append a version recording no decision anybody made.
   */
  const currentAfterUnit =
    nextUnit === null && current ? { ...current, target_value: null } : current;

  const detailsChanged = trimmed !== habit.name || color !== habit.color_token || unitChanged;
  const scheduleChanged = paused
    ? !wasPaused
    : wasPaused || !matchesSchedule(currentAfterUnit, saving);
  const changed = detailsChanged || scheduleChanged;

  /*
   * The one change the server does not start when it is asked to: switching
   * between certain days and times a week moves to the following Monday,
   * because a week cannot be scored half as a set of named days and half as a
   * count over seven of them.
   *
   * Which saves *may* be deferred is knowable here without a clock — it is a
   * property of the two kinds, not of the date — and that is the whole test
   * this needs. Whether one actually was deferred is not knowable: /habits
   * resolves a schedule as of today and carries no version dated later, and the
   * client must never decide for itself what day it is. So the answer comes
   * from the server, as the effective_from it returns, and is simply shown.
   * On a Monday that date is today, which reads as true rather than as news.
   *
   * Pausing and resuming are never deferred — neither is a scoring kind — and
   * neither is a change of days, of weekly target, or of the amount asked for
   * each time.
   */
  /*
   * The change that is decided but not yet in force: the server's, from the
   * payload, or the one just stored — which arrives a beat before the refetched
   * list carries it, so preferring it keeps the panel from flickering in.
   */
  const upcoming = saved ?? habit.next_schedule;

  /*
   * Renamed from `unitChanged`. "Unit" now means the thing a habit is measured
   * in, and this has never been about that: it is a change of *scoring kind*,
   * certain days becoming times a week or back. Two unrelated meanings of one
   * word in one file is how the wrong one gets read at three in the morning.
   */
  const kindChanged =
    !paused && !wasPaused && current !== null && current.schedule_kind !== saving.kind;

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
            // Only when it actually changed. The server patches by key
            // presence, so sending it every time would turn a rename into a
            // unit write — which a habit that has measured anything refuses.
            ...(unitChanged ? { unit: nextUnit } : {}),
          },
        });
      }
      if (scheduleChanged) {
        const stored = await schedule.mutateAsync({
          id: habit.id,
          schedule: paused ? { schedule_kind: "paused" } : toScheduleInput(saving),
        });
        // Staying open is the point: closing on a change that has not started
        // yet drops the person back on a list still showing the old schedule,
        // which is what made a successful save look like a failed one.
        if (kindChanged) {
          setSaved(stored.schedule);
          return;
        }
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
          <label htmlFor="edit-name" className="label text-muted block pb-2.5">
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

        <div>
          <label htmlFor="edit-unit" className="label text-muted block pb-2.5">
            Measured in (optional)
          </label>
          <input
            id="edit-unit"
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            maxLength={20}
            disabled={unitLocked}
            placeholder="km, pages, glasses…"
            aria-describedby="edit-unit-hint"
            className={`${FIELD} disabled:opacity-50`}
          />
          <p id="edit-unit-hint" className="text-meta text-muted mt-1.5">
            {unitLocked
              ? // Not a refusal to be argued with: every number already recorded
                // is in this unit and no row remembers which, so changing it
                // would quietly re-mean all of them. Say what to do instead.
                //
                // Both kinds of number are named, because the server locks on
                // either and does not say which here — a target is history too,
                // and a habit can be frozen by one before it has ever been
                // logged. Working out which applies would mean recomputing the
                // server's rule on the client, which is the thing unit_locked
                // exists to avoid.
                `This habit has days measured in ${habit.unit}, or targets set in it, so the unit is now fixed — changing it would silently re-mean every number behind it. To measure in something else, archive this habit and start a new one.`
              : "Leave this blank to just tick the day off. Adding a unit lets you record how much, which is reported on its own and never changes a streak."}
          </p>
        </div>

        {/* Disabled natively rather than hidden, so a paused habit still shows
            the schedule the checkbox below will resume it on. Choice dims its
            own disabled controls — do not dim the fieldset as well. */}
        <fieldset disabled={paused}>
          {/* `nextUnit`, not `habit.unit`: the target field has to appear the
              moment a unit is typed and go the moment it is deleted, or the
              two are only settable in two separate saves. */}
          <SchedulePicker draft={saving} unit={nextUnit} onChange={setDraft} />
        </fieldset>

        <label className="border-baseline flex min-h-12 cursor-pointer items-center gap-3 border px-3.5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2">
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
            : // `kindChanged`, not `unitChanged`. This sentence is about the
              // scoring kind — certain days becoming times a week — and reading
              // it off the measured unit made it say the wrong thing twice:
              // it appeared when the unit was edited, where no deferral happens,
              // and it was missing on the one change that is actually deferred,
              // which then promised "takes effect today" and stored next Monday.
              kindChanged
              ? "Moving between certain days and times a week starts on a Monday: a week is scored either as days or as a count, never half of each. The week you are in keeps the schedule it began with."
              : "A schedule change takes effect today. Past weeks keep the schedule they were lived under."}
        </p>

        {/* Announced as a status so a save that starts later is spoken as well
            as shown; present on open too, where a live region stays silent. */}
        {upcoming && (
          <div role="status" className="border-grid bg-raised text-meta border p-3">
            <p className="text-muted">{saved ? "Saved. Upcoming change" : "Upcoming change"}</p>
            <p className="font-medium">
              {scheduleWords(
                upcoming.schedule_kind,
                upcoming.schedule_days,
                upcoming.weekly_target,
                upcoming.target_value,
                nextUnit,
              )}
            </p>
            <p className="text-muted">
              Starts {formatDateLong(upcoming.effective_from)}. Until then this habit keeps the
              schedule it has now, and the days already behind it keep theirs.
            </p>
          </div>
        )}

        {saveError && (
          <p role="alert" className="text-warn text-meta">
            {saveError.message}
          </p>
        )}

        <div className="grid gap-2">
          <button
            type="button"
            className={PRIMARY}
            disabled={!saved && (!trimmed || !isDraftValid(saving) || !changed || busy)}
            onClick={() => (saved ? onClose() : void save())}
          >
            {saved ? "Done" : busy ? "Saving…" : changed ? "Save changes" : "Saved"}
          </button>
          {!saved && (
            <button type="button" className={QUIET} onClick={onClose}>
              Cancel
            </button>
          )}
        </div>

        <div className="border-grid grid gap-2 border-t pt-4">
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
