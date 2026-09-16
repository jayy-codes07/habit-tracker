import type { ReactNode } from "react";

import { RING } from "./form";

/**
 * A position on a dial: an sr-only input with a styled label, so grouping,
 * arrow-key navigation and announcement come from the platform and only the
 * appearance is ours.
 *
 * The appearance is the instrument's range switch. Every choice in a group
 * sits on one shared rule and the selected one raises a TICK out of it — a
 * scale reading, not a pressed pill. Filling the selected one instead would put
 * a solid block in a system where a solid block already means "this day was
 * done", and the two would be competing for the same shape.
 *
 * A checkbox group simply marks more than one position, which is the right
 * reading for the weekday picker: several days on a scale of seven.
 *
 * Positions are adjacent by design — the parent lays them out with `flex` and
 * NO gap, so the rule under them is continuous. A gap would break the scale
 * into separate objects and lose the whole idea.
 */
export function Choice({
  type,
  name,
  checked,
  onChange,
  label,
  disabled = false,
  className = "",
  children,
}: {
  type: "radio" | "checkbox";
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  /** The label already styles for it — has-[:disabled]:opacity-40 — so only the input was missing. */
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label
      className={`border-baseline relative flex min-h-11 flex-1 cursor-pointer items-center justify-center border-t px-1.5 text-center transition-colors has-[:focus-visible]:outline-offset-2 has-[:disabled]:cursor-default has-[:disabled]:opacity-40 ${RING} ${
        checked ? "text-ink" : "text-muted hover:text-ink"
      } ${className}`}
    >
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-label={label}
        className="sr-only"
      />
      {/* The tick rises OUT of the shared rule and points at its OWN label. On
          the position's left edge it read as belonging to the position before. */}
      {checked && (
        <span
          aria-hidden="true"
          className="bg-ink absolute top-[-1px] left-1/2 h-2.5 w-0.5 -translate-x-1/2"
        />
      )}
      <span aria-hidden="true" className={`label ${checked ? "text-ink" : ""}`}>
        {children}
      </span>
    </label>
  );
}
