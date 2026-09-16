import { useState, type FormEvent } from "react";

import { Dialog } from "../../components/Dialog";
import { FIELD, PRIMARY, QUIET } from "../../components/form";
import { ColorPicker } from "./ColorPicker";
import { leastUsedColor } from "./colors";
import { SchedulePicker } from "./SchedulePicker";
import { draftFor, EVERY_DAY, isDraftValid, toScheduleInput, type ScheduleDraft } from "./schedule";
import { useCreateHabit } from "./queries";
import type { ColorToken } from "../../types";

export function NewHabitDialog({
  open,
  onClose,
  taken = [],
}: {
  open: boolean;
  onClose: () => void;
  /**
   * The colours already in use by the habits the caller has on screen. Passed
   * in rather than fetched: both callers are already holding a list of habits,
   * and this dialog stays mounted while closed, so a query here would be a
   * request every visit for a suggestion nobody has asked for yet.
   */
  taken?: ColorToken[];
}) {
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<ColorToken | null>(null);
  const [unit, setUnit] = useState("");
  const [draft, setDraft] = useState<ScheduleDraft>({
    kind: "fixed",
    days: EVERY_DAY,
    amount: null,
  });
  const create = useCreateHabit();

  /*
   * "Nothing chosen yet" is a state of its own, so the suggestion is derived at
   * render rather than copied into state when the dialog opens. Copying it
   * would have to be an effect — this dialog outlives any one use of it, and
   * the habit added last time changes what the least-used colour now is — and
   * an effect that calls setColor renders twice and fights whatever the person
   * clicked. Clearing `chosen` on close is all "reset for next time" needs.
   */
  const color = chosen ?? leastUsedColor(taken);

  const close = () => {
    create.reset();
    setName("");
    setChosen(null);
    setUnit("");
    setDraft({ kind: "fixed", days: EVERY_DAY, amount: null });
    onClose();
  };

  // Blank means binary. Held apart from the raw box so the rule is stated once.
  const measuredIn = unit.trim() === "" ? null : unit.trim();
  /*
   * The schedule as it will actually be sent. Typing a unit, setting a target
   * and then deleting the unit again used to leave the amount behind in the
   * draft, and the server answered a target with no unit by committing a habit
   * with no schedule version at all. It refuses that now; this stops the
   * request being made in the first place.
   */
  const saving = draftFor(draft, measuredIn);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !isDraftValid(saving)) return;
    // start_date is left to the server, which defaults it to today. Back-dating
    // a habit fills its grid with days it was never logged on, so a habit you
    // are only starting now would open on a wall of failures.
    create.mutate(
      {
        name: name.trim(),
        color_token: color,
        // A blank box is a binary habit, which is most of them. Sending "" would
        // be a unit that names nothing, and the server refuses one.
        ...(measuredIn === null ? {} : { unit: measuredIn }),
        schedule: toScheduleInput(saving),
      },
      { onSuccess: close },
    );
  };

  return (
    <Dialog open={open} onClose={close} title="New habit">
      <form onSubmit={submit} className="grid gap-5">
        <div>
          <label htmlFor="habit-name" className="label text-muted block pb-2.5">
            Name
          </label>
          <input
            id="habit-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            autoFocus
            placeholder="Morning run"
            className={FIELD}
          />
        </div>

        <ColorPicker value={color} onChange={setChosen} />

        <div>
          <label htmlFor="habit-unit" className="label text-muted block pb-2.5">
            Measured in (optional)
          </label>
          <input
            id="habit-unit"
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            maxLength={20}
            placeholder="km, pages, glasses…"
            aria-describedby="habit-unit-hint"
            className={FIELD}
          />
          <p id="habit-unit-hint" className="text-meta text-muted mt-1.5">
            Leave blank to just tick the day off. You can add this later, but not change it once
            days have been measured.
          </p>
        </div>

        {/*
         * The target lives in the picker and only appears once there is a unit
         * to count in — so typing one here reveals it, which is the order the
         * two are actually decided in.
         */}
        <SchedulePicker draft={saving} unit={measuredIn} onChange={setDraft} />

        {create.isError && (
          <p role="alert" className="text-warn text-meta">
            {(create.error as Error).message}
          </p>
        )}

        <div className="grid gap-2">
          <button
            type="submit"
            className={PRIMARY}
            disabled={!name.trim() || !isDraftValid(saving) || create.isPending}
          >
            {create.isPending ? "Adding…" : "Add habit"}
          </button>
          <button type="button" onClick={close} className={QUIET}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
