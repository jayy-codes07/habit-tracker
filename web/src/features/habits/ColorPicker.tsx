/**
 * The five theme tokens, as five pen bars.
 *
 * A colour identifies a habit and never says how a day went, so this is pure
 * identity — no state ever reaches these swatches. They are bars rather than
 * dots because a bar is the shape the rest of the app uses for "this habit":
 * the mark beside a name on Pattern, Review and a habit's own history. A dot
 * was a sixth shape doing a job five already did.
 *
 * The choice is marked by a rule drawn UNDER the bar, not by a tick inside it —
 * a tick on a coloured ground is the one mark this app reserves for "done".
 */
import { RING } from "../../components/form";
import { COLORS } from "./colors";
import type { ColorToken } from "../../types";

export function ColorPicker({
  value,
  onChange,
}: {
  value: ColorToken;
  onChange: (token: ColorToken) => void;
}) {
  return (
    <fieldset>
      <legend className="label text-muted pb-2.5">Colour</legend>
      <div className="flex gap-2">
        {COLORS.map(({ token, name }) => (
          <label
            key={token}
            className={`relative grid h-11 w-11 cursor-pointer place-items-center ${RING}`}
          >
            <input
              type="radio"
              name="habit-color"
              checked={value === token}
              onChange={() => onChange(token)}
              aria-label={name}
              className="sr-only"
            />
            <span
              aria-hidden="true"
              className="h-6 w-[5px]"
              style={{ background: `var(--c-${token})` }}
            />
            {value === token && (
              <span aria-hidden="true" className="bg-ink absolute inset-x-1.5 bottom-1 h-0.5" />
            )}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
