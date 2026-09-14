/**
 * The five habit colours, and how a new habit picks one.
 *
 * Separate from ColorPicker so the swatches and the default cannot disagree
 * about the list or its order — and because a module that exports a component
 * and a plain function loses fast refresh.
 */
import type { ColorToken } from "../../types";

export const COLORS: { token: ColorToken; name: string }[] = [
  { token: "chart-1", name: "Blue" },
  { token: "chart-2", name: "Teal" },
  { token: "chart-3", name: "Violet" },
  { token: "chart-4", name: "Green" },
  { token: "chart-5", name: "Sand" },
];

/**
 * The colour a new habit should start on: whichever is doing the least work
 * already.
 *
 * Every new habit used to open on Blue, so anyone who did not stop to choose
 * ended up with five blue dots — and the colour is the only thing telling one
 * row from another at a glance in the grid, where the name is a line above and
 * the cells are 14px squares. Five identical rows is the grid failing at the
 * one job it has.
 *
 * Ties break on the order above rather than at random, so the second habit is
 * reliably Teal and the same list always suggests the same colour. Archived
 * habits are not counted: their colour is free again, and the point is only to
 * tell apart the habits on screen together.
 */
export function leastUsedColor(taken: ColorToken[]): ColorToken {
  const counts = new Map<ColorToken, number>(COLORS.map(({ token }) => [token, 0]));
  for (const token of taken) {
    const seen = counts.get(token);
    if (seen !== undefined) counts.set(token, seen + 1);
  }

  let best = COLORS[0]!.token;
  for (const { token } of COLORS) {
    if (counts.get(token)! < counts.get(best)!) best = token;
  }
  return best;
}
