/**
 * The line icons the screens share. Inline SVG rather than an icon package:
 * five paths are smaller than a dependency, and they inherit currentColor.
 */
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const Check = () => (
  <svg viewBox="0 0 12 12" className="h-3.5 w-3.5" {...stroke} strokeWidth={2.2} aria-hidden="true">
    <path d="M2.2 6.2 4.8 8.8 9.8 3.2" />
  </svg>
);

export const Cross = () => (
  <svg viewBox="0 0 12 12" className="h-3 w-3" {...stroke} aria-hidden="true">
    <path d="M3.4 3.4 8.6 8.6M8.6 3.4 3.4 8.6" />
  </svg>
);

export const Dash = () => (
  <svg viewBox="0 0 12 12" className="h-3 w-3" {...stroke} aria-hidden="true">
    <path d="M3 6h6" />
  </svg>
);

export const Chevron = ({ className = "" }: { className?: string }) => (
  <svg viewBox="0 0 16 16" className={`h-4 w-4 ${className}`} {...stroke} aria-hidden="true">
    <path d="M6 3.5 10.5 8 6 12.5" />
  </svg>
);

export const Ellipsis = () => (
  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden="true">
    <circle cx="8" cy="3" r="1.4" />
    <circle cx="8" cy="8" r="1.4" />
    <circle cx="8" cy="13" r="1.4" />
  </svg>
);
