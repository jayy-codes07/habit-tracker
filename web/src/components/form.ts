/**
 * The class recipes every form control in the app is drawn with. Shared because
 * a field on the habit sheet and a field on a task dialog are the same control;
 * a second copy is how two dialogs quietly stop matching.
 *
 * Nothing here has a radius and nothing here is a box. In a system where the
 * only surface is the canvas, a control is told apart from the page by a RULE —
 * a field is a baseline, a quiet button is an underline, a primary button is a
 * solid key. That is the whole vocabulary, and it is why no control needs a
 * fill, a border on four sides, or an elevation to be legible.
 */

/**
 * An input is a baseline, not a box. Focus thickens it to ink rather than
 * moving it, so the field does not jump by a pixel when it is entered.
 *
 * 16px is not a taste: anything smaller and iOS zooms the viewport on focus.
 */
export const FIELD =
  "border-baseline focus:border-ink text-field placeholder:text-faint min-h-12 w-full border-0 border-b bg-transparent px-0 outline-none transition-colors focus:border-b-2";

/** A machine key: solid ink, square, and the label set in the machine's voice. */
export const PRIMARY =
  "label bg-ink text-canvas min-h-12 w-full px-4 transition-opacity disabled:opacity-40";

/**
 * Text with a rule under it. No box, and still a 44px target.
 *
 * inline-flex, not the default inline: `min-height` does nothing to an inline
 * box, so the anchor this is also used on came out 13px tall while the buttons
 * beside it were 44. A target that depends on which element you happened to
 * put the class on is not a target.
 */
export const QUIET =
  "label text-ink hover:text-muted inline-flex min-h-11 items-center px-0 underline decoration-[var(--c-baseline)] decoration-1 underline-offset-[6px] transition-colors disabled:opacity-40";

export const RING = "has-[:focus-visible]:outline-ink has-[:focus-visible]:outline-2";

/**
 * A square icon-only control: the day and month steppers, and the reorder
 * arrows. It was written out three times in routes/, which is the drift this
 * file exists to prevent — the steppers on two screens are the same control.
 *
 * Borderless, because a bordered box beside a baseline field is two different
 * ideas of what a control looks like on one row.
 */
export const ICON_BUTTON =
  "text-muted hover:text-ink hover:bg-raised grid h-11 w-11 place-items-center transition-colors disabled:opacity-30 disabled:hover:bg-transparent";
