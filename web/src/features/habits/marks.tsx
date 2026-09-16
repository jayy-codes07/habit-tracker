/**
 * The dash on a skipped cell, drawn rather than iconed so it survives an 11px
 * cell. Its own file because it is the one part of the state vocabulary that is
 * markup; the rest is paint() in verdict.ts.
 *
 * Square, not rounded — nothing in this system has a radius — and 60% of the
 * cell rather than half, because the cell is now bare paper instead of a filled
 * tray and the dash is the ONLY thing separating "skipped" from "nothing was
 * asked". It reads better than it used to despite being smaller relative to its
 * ground: --c-muted is 7:1 on the canvas against 2.4:1 on the old tray.
 */
export const SkipMark = () => (
  <span aria-hidden="true" className="bg-muted block h-[1.5px] w-[60%]" />
);
