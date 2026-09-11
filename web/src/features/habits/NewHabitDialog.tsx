import { useState, type FormEvent } from "react";

import { Dialog } from "../../components/Dialog";
import { FIELD, PRIMARY, QUIET, RING } from "../../components/form";
import { SchedulePicker } from "./SchedulePicker";
import { EVERY_DAY, isDraftValid, toScheduleInput, type ScheduleDraft } from "./schedule";
import { useCreateHabit } from "./queries";
import type { ColorToken } from "../../types";

const COLORS: { token: ColorToken; name: string }[] = [
  { token: "chart-1", name: "Blue" },
  { token: "chart-2", name: "Teal" },
  { token: "chart-3", name: "Violet" },
  { token: "chart-4", name: "Green" },
  { token: "chart-5", name: "Sand" },
];

export function NewHabitDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<ColorToken>("chart-1");
  const [draft, setDraft] = useState<ScheduleDraft>({ kind: "fixed", days: EVERY_DAY });
  const create = useCreateHabit();

  const close = () => {
    create.reset();
    setName("");
    setColor("chart-1");
    setDraft({ kind: "fixed", days: EVERY_DAY });
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !isDraftValid(draft)) return;
    // start_date is left to the server, which defaults it to today. Back-dating
    // a habit fills its grid with days it was never logged on, so a habit you
    // are only starting now would open on a wall of failures.
    create.mutate(
      { name: name.trim(), color_token: color, schedule: toScheduleInput(draft) },
      { onSuccess: close },
    );
  };

  return (
    <Dialog open={open} onClose={close} title="New habit">
      <form onSubmit={submit} className="grid gap-5">
        <div>
          <label htmlFor="habit-name" className="text-meta text-muted block pb-1.5">
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

        <fieldset>
          <legend className="text-meta text-muted pb-1.5">Colour</legend>
          <div className="flex gap-2">
            {COLORS.map(({ token, name: colorName }) => (
              <label
                key={token}
                className={`grid h-11 w-11 cursor-pointer place-items-center rounded-full ${RING}`}
              >
                <input
                  type="radio"
                  name="habit-color"
                  checked={color === token}
                  onChange={() => setColor(token)}
                  aria-label={colorName}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className="h-6 w-6 rounded-full transition-shadow"
                  style={{
                    background: `var(--c-${token})`,
                    boxShadow:
                      color === token
                        ? "0 0 0 2px var(--c-canvas), 0 0 0 4px var(--c-ink)"
                        : "none",
                  }}
                />
              </label>
            ))}
          </div>
        </fieldset>

        <SchedulePicker draft={draft} onChange={setDraft} />

        {create.isError && (
          <p role="alert" className="text-warn text-meta">
            {(create.error as Error).message}
          </p>
        )}

        <div className="grid gap-2">
          <button
            type="submit"
            className={PRIMARY}
            disabled={!name.trim() || !isDraftValid(draft) || create.isPending}
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
