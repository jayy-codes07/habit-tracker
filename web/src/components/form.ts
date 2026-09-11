/**
 * The class recipes every form control in the app is drawn with. Shared because
 * a field on the habit sheet and a field on a task dialog are the same control;
 * a second copy is how two dialogs quietly stop matching.
 */
export const FIELD =
  "border-line-strong bg-canvas text-field focus:border-ink min-h-12 w-full rounded-lg border px-3.5 outline-none";
export const PRIMARY =
  "bg-ink text-canvas min-h-12 w-full rounded-lg px-4 font-semibold disabled:opacity-40";
export const QUIET =
  "border-line-strong hover:bg-raised min-h-12 w-full rounded-lg border px-4 font-medium disabled:opacity-40";
export const RING = "has-[:focus-visible]:outline-ink has-[:focus-visible]:outline-2";
