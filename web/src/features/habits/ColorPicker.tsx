/**
 * The five theme tokens, as five dots.
 *
 * A colour identifies a habit and never says how a day went, so this is pure
 * identity — no state ever reaches these swatches. The ring rather than a tick
 * marks the choice, because a tick inside a coloured circle is the one mark
 * this app reserves for "done".
 */
import { RING } from "../../components/form";
import type { ColorToken } from "../../types";

const COLORS: { token: ColorToken; name: string }[] = [
  { token: "chart-1", name: "Blue" },
  { token: "chart-2", name: "Teal" },
  { token: "chart-3", name: "Violet" },
  { token: "chart-4", name: "Green" },
  { token: "chart-5", name: "Sand" },
];

export function ColorPicker({
  value,
  onChange,
}: {
  value: ColorToken;
  onChange: (token: ColorToken) => void;
}) {
  return (
    <fieldset>
      <legend className="text-meta text-muted pb-1.5">Colour</legend>
      <div className="flex gap-2">
        {COLORS.map(({ token, name }) => (
          <label
            key={token}
            className={`grid h-11 w-11 cursor-pointer place-items-center rounded-full ${RING}`}
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
              className="h-6 w-6 rounded-full transition-shadow"
              style={{
                background: `var(--c-${token})`,
                boxShadow:
                  value === token ? "0 0 0 2px var(--c-canvas), 0 0 0 4px var(--c-ink)" : "none",
              }}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
