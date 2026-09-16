/**
 * How a sheet is looked at, as opposed to what it draws.
 *
 * Both of these are the caller's half of a decision Sheet.tsx cannot make on
 * its own: where the scroller is parked, and how big a cell may be. They live
 * apart from Sheet.tsx because a module that exports components must not also
 * export hooks — fast refresh cannot tell which is which and gives up on the
 * whole file.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from "react";

/**
 * A scroller parked on the most recent weeks rather than the oldest.
 *
 * A scroller starts at its left edge, which on a sheet is a year ago. The sheet
 * reads left to right because that is how time runs; where it is PARKED is a
 * different question and the answer is now. Overshooting is fine — the browser
 * clamps scrollLeft — so this needs no measurement and cannot land half a
 * column off.
 *
 * ONE scroller wraps every block on the grid. Seven independent ones meant
 * seven rows that could be parked on seven different weeks, so a column no
 * longer meant a date; the caller owns the element for exactly that reason, and
 * this owns only the rule.
 */
export function useParkedScroller(deps: unknown[]): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element) element.scrollLeft = element.scrollWidth;
    // The caller decides what invalidates the parking — the payload's own start
    // and week count, never the requested range, so this cannot fire against
    // placeholder cells and a scrollWidth that is about to change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/**
 * The cell size to draw at, chosen by viewport rather than measured.
 *
 * A sheet positions its paper, pen and cuts in pixels, so the cell cannot be a
 * `minmax()` the browser resolves — the overlays would not line up with the
 * cells. A media query is the cheap half of that trade: no ResizeObserver, no
 * layout thrash, and a re-render only when the breakpoint is actually crossed.
 *
 * 11px is the floor the whole state vocabulary is verified at, in greyscale, in
 * both themes. 16 is as large as a square should get before a habit's run stops
 * reading as one shape.
 */
export function useSheetCell(narrow = 11, wide = 16): number {
  const subscribe = useCallback((notify: () => void) => {
    const query = window.matchMedia("(min-width: 64rem)");
    query.addEventListener("change", notify);
    return () => query.removeEventListener("change", notify);
  }, []);
  const isWide = useSyncExternalStore(
    subscribe,
    () => window.matchMedia("(min-width: 64rem)").matches,
    () => false,
  );
  return isWide ? wide : narrow;
}
