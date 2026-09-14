/**
 * Calendar-day arithmetic on "YYYY-MM-DD" strings.
 *
 * Mirrors server/src/lib/dates.js: every date is anchored at noon UTC, so a DST
 * transition can never push a result onto the neighbouring day, and formatting
 * is pinned to UTC so the browser's own zone cannot shift the label off the date
 * it was given. ISO date strings also compare lexicographically, so `a <= b` is
 * a correct comparison and nothing here needs to parse for that.
 *
 * What "today" is never comes from here — it comes from the server, on the
 * /day, /grid and /tasks payloads, because the day rolls over in APP_TIMEZONE.
 */
import type { IsoDate, IsoMonth } from "../types";

const at = (iso: IsoDate) => new Date(`${iso}T12:00:00Z`);

export function addDays(iso: IsoDate, days: number): IsoDate {
  const date = at(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** ISO-8601 weekday: 1 = Monday ... 7 = Sunday. */
export const isoWeekday = (iso: IsoDate): number => at(iso).getUTCDay() || 7;

/**
 * The browser's own date. Its only sanctioned use is choosing which period a
 * screen opens on — the day for /, the month for /review — and never deciding
 * how something is scored or grouped. Opening on the wrong one is ambiguous for
 * a few hours at a boundary and costs one tap of the stepper; grading against
 * the wrong one silently contradicts the rest of the app.
 */
export const browserToday = (): IsoDate => {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

const format = (iso: IsoDate, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(at(iso));

/** "Friday 11 September" — the Day screen's heading. */
export const formatDateLong = (iso: IsoDate) =>
  format(iso, { weekday: "long", day: "numeric", month: "long" });

/** "11 Sep 2026" — when the year is not obvious. */
export const formatDateShort = (iso: IsoDate) =>
  format(iso, { day: "numeric", month: "short", year: "numeric" });

/** "Fri" */
export const formatWeekday = (iso: IsoDate) => format(iso, { weekday: "short" });

/**
 * "Today" / "Yesterday" / "Tomorrow", or null when the date is far enough away
 * to deserve its real name. `today` must come from the payload.
 */
export function relativeDay(iso: IsoDate, today: IsoDate): string | null {
  if (iso === today) return "Today";
  if (iso === addDays(today, -1)) return "Yesterday";
  if (iso === addDays(today, 1)) return "Tomorrow";
  return null;
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export const daysBetween = (from: IsoDate, to: IsoDate): number =>
  Math.round((at(to).getTime() - at(from).getTime()) / 86_400_000);

/** "Sep" — the grid's column labels, where a month begins. */
export const formatMonthShort = (iso: IsoDate) => format(iso, { month: "short" });

/** Step whole months on a "YYYY-MM". Arithmetic on the index, so December wraps. */
export function addMonths(month: IsoMonth, delta: number): IsoMonth {
  const [year, index] = month.split("-").map(Number);
  const total = year! * 12 + (index! - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** "September 2026" — the review's heading. */
export const formatMonthLong = (month: IsoMonth) =>
  format(`${month}-01`, { month: "long", year: "numeric" });

/** The month a date falls in. */
export const monthOf = (iso: IsoDate): IsoMonth => iso.slice(0, 7);
