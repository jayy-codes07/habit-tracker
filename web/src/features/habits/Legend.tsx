/**
 * The key to the sheet's marks.
 *
 * It lives beside every sheet that is drawn — Pattern and a habit's history —
 * because the vocabulary is the same one in both places and a key on one screen
 * teaches nothing on the other. It sits ABOVE the drawing, not under it: a key
 * found after scrolling a year of squares is a key found after the confusion it
 * exists to prevent.
 *
 * The swatches are drawn the way the sheet draws them: paper first, ink on top.
 * A swatch that was only the ink would omit the half of the language the ruling
 * carries — which is the half that tells a rest day from a pause.
 */
import { useMemo } from "react";

import { SkipMark } from "./marks";
import { CELL, paint, paperOf } from "./verdict";
import type { Verdict } from "../../types";

const LEGEND: { verdict: Verdict; label: string }[] = [
  { verdict: "done", label: "Done" },
  { verdict: "bonus", label: "Extra" },
  { verdict: "skipped", label: "Skipped" },
  { verdict: "missed", label: "Missed" },
  { verdict: "unlogged", label: "Not logged" },
  /*
   * "Rest day", not "Nothing asked". One state must have one name, and this is
   * the name the rest of the product already uses for it — VERDICT_LABEL on the
   * cell itself, and metaLine on the Day screen. The legend was the odd one out.
   */
  { verdict: "unscheduled", label: "Rest day" },
  { verdict: "paused", label: "Paused" },
];

const PAPER_SWATCH: Record<string, string> = {
  on: "bg-tray",
  peck: "peck-paper",
  dim: "bg-tray opacity-40",
  none: "hidden",
};

/**
 * `cells` is every sheet's cells on the screen, concatenated — only the marks
 * actually drawn are named. A key for states nobody has is noise, and noise is
 * what stops a key being read.
 */
export function Legend({ cells }: { cells: string }) {
  const present = useMemo(() => {
    const seen = new Set<Verdict>();
    for (const char of cells) {
      const verdict = CELL[char];
      if (verdict) seen.add(verdict);
    }
    return seen;
  }, [cells]);

  const shown = LEGEND.filter((item) => present.has(item.verdict));
  if (shown.length === 0) return null;

  return (
    <ul className="label text-muted flex flex-wrap items-center gap-x-5 gap-y-2.5">
      {/* Named, because an unlabelled row of squares is one more thing to work
          out rather than the thing that explains the others. */}
      <li className="text-ink">Key</li>
      {shown.map((item) => (
        <li key={item.verdict} className="flex items-center gap-2">
          <span aria-hidden="true" className="relative block h-4 w-4 shrink-0">
            <span
              className="grid h-[13px] w-full place-items-center"
              // chart-1 stands in for "a habit's colour"; the shape is the part
              // the legend is actually teaching.
              style={paint(item.verdict, "var(--c-chart-1)")}
            >
              {item.verdict === "skipped" && <SkipMark />}
            </span>
            <span
              className={`absolute inset-x-0 h-px ${PAPER_SWATCH[paperOf(item.verdict)]}`}
              style={{ top: 13 }}
            />
          </span>
          {item.label}
        </li>
      ))}
    </ul>
  );
}
