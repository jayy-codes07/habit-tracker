/**
 * A number of something, in a habit's own unit.
 *
 * Two screens ask for one — the target on the schedule picker, and the day's
 * measurement on the habit sheet — and they are the same control: same bounds,
 * same empty-means-null rule, same unit printed after the box. A second copy is
 * how two dialogs quietly stop agreeing about what 0 means.
 *
 * Empty is not zero. A blank box means "no amount", which is a real answer in
 * both places: a habit may measure without aiming at anything, and a day may be
 * done without being measured. So the value this reports is `number | null`, and
 * the text the person is halfway through typing is held here rather than being
 * round-tripped through a number the parent would have to reformat.
 */
import { useState } from "react";

import { FIELD } from "../../components/form";
import { MAX_AMOUNT, MIN_AMOUNT, type Amount } from "./schedule";

/**
 * Text to an amount. `undefined` means "not a number at all" — which is not the
 * same as null, and must not be saved as one: a half-typed "1." should leave the
 * stored amount alone rather than clearing it.
 */
function parseAmount(text: string): Amount | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

/** Why this amount cannot be stored, in the words the person would use. */
function amountProblem(amount: Amount, { allowZero }: { allowZero: boolean }): string | null {
  if (amount === null) return null;
  if (amount === 0) {
    return allowZero
      ? null
      : "A day you count as done cannot measure zero — leave this blank if you did not measure.";
  }
  if (amount < 0) return "That cannot be less than nothing.";
  // Below the precision the database stores, where it would round to zero.
  if (amount < MIN_AMOUNT) return `The smallest amount that can be recorded is ${MIN_AMOUNT}.`;
  if (amount > MAX_AMOUNT) return "That is larger than this can record.";
  return null;
}

export function AmountField({
  id,
  label,
  unit,
  value,
  placeholder,
  disabled = false,
  allowZero = false,
  hint,
  onCommit,
}: {
  id: string;
  label: string;
  unit: string;
  value: Amount;
  placeholder?: string;
  disabled?: boolean;
  /** Zero is a real measurement on a missed day, and a contradiction on a done one. */
  allowZero?: boolean;
  hint?: string;
  /** Called only with an amount that could actually be stored. */
  onCommit: (amount: Amount) => void;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const parsed = parseAmount(text);
  const problem =
    parsed === undefined ? "That is not a number." : amountProblem(parsed, { allowZero });

  return (
    <div>
      <label htmlFor={id} className="label text-muted block pb-2.5">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          // `inputMode` rather than type="number": a numeric keypad on a phone,
          // without the spinner, the scroll-wheel edit, or the silent discard of
          // text the browser dislikes — which would make a typo vanish instead of
          // being correctable.
          type="text"
          inputMode="decimal"
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          aria-describedby={problem ? `${id}-problem` : hint ? `${id}-hint` : undefined}
          aria-invalid={problem ? true : undefined}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            // Nothing storable is nothing saved. The text stays as typed so the
            // person can fix it rather than watching it disappear.
            if (parsed === undefined || problem) return;
            if (parsed !== value) onCommit(parsed);
          }}
          className={`${FIELD} flex-1 tabular disabled:opacity-50`}
        />
        <span className="text-muted shrink-0">{unit}</span>
      </div>
      {problem ? (
        <p id={`${id}-problem`} role="alert" className="text-warn text-meta mt-1.5">
          {problem}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-meta text-muted mt-1.5">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
