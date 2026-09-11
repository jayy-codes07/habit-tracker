import type { ReactNode } from "react";

import { RING } from "./form";

/** An sr-only input with a styled label: native semantics, our appearance. */
export function Choice({
  type,
  name,
  checked,
  onChange,
  label,
  className = "",
  children,
}: {
  type: "radio" | "checkbox";
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label
      className={`grid min-h-11 cursor-pointer place-items-center rounded-lg border text-center transition-colors has-[:focus-visible]:outline-offset-2 has-[:disabled]:cursor-default has-[:disabled]:opacity-40 ${RING} ${
        checked
          ? "border-ink bg-ink text-canvas font-semibold"
          : "border-line-strong hover:bg-raised"
      } ${className}`}
    >
      <input
        type={type}
        name={name}
        checked={checked}
        onChange={onChange}
        aria-label={label}
        className="sr-only"
      />
      <span aria-hidden="true">{children}</span>
    </label>
  );
}
