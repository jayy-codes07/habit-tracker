/**
 * Calendar dates, as 'YYYY-MM-DD' strings.
 *
 * The whole application speaks this one representation. src/db overrides the
 * node-postgres parser for oid 1082 so DATE columns arrive as these strings and
 * never as Date objects, and everything here keeps them that way: a Date is an
 * instant, a calendar day is not, and converting between them is where timezone
 * bugs come from.
 *
 * Two properties this buys, both relied on elsewhere:
 *   * ISO date strings sort and compare lexicographically, so `a <= b` is a
 *     correct date comparison and needs no parsing.
 *   * Arithmetic happens at noon UTC internally, so a DST transition can never
 *     push a result onto the neighbouring day. Midnight-anchored arithmetic can.
 *
 * `today()` is the single source of the application's current date. Nothing
 * outside this file may call `new Date()` to find out what day it is: the
 * container runs in UTC, so a server-clock "today" is wrong for part of every
 * day in any other timezone, and a habit tracker that decides the day wrongly
 * reports broken streaks.
 */
import { config } from "../config/index.js";

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;

// ---------------------------------------------------------------------------
// Parsing and formatting
// ---------------------------------------------------------------------------

/**
 * Noon-UTC epoch milliseconds for a calendar date, or null when the string is
 * not a real day.
 *
 * The round-trip check is what rejects '2026-02-31': Date.UTC happily rolls it
 * forward to March 3rd, and without this every such value would reach Postgres
 * and come back as a 500 instead of a 400.
 */
function toStamp(iso) {
  if (typeof iso !== "string" || !ISO_DATE.test(iso)) return null;

  const [year, month, day] = iso.split("-").map(Number);
  const stamp = Date.UTC(year, month - 1, day, 12);
  const back = new Date(stamp);

  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1) return null;
  if (back.getUTCDate() !== day) return null;

  return stamp;
}

/** True when `value` is a well-formed, real calendar date. */
export function isIsoDate(value) {
  return toStamp(value) !== null;
}

/** True when `value` is a well-formed 'YYYY-MM' month. */
export function isIsoMonth(value) {
  return typeof value === "string" && ISO_MONTH.test(value) && isIsoDate(`${value}-01`);
}

/** Throws rather than returning null, for callers that already validated. */
function requireStamp(iso) {
  const stamp = toStamp(iso);
  if (stamp === null) throw new TypeError(`Not a calendar date: ${JSON.stringify(iso)}`);
  return stamp;
}

const fromStamp = (stamp) => new Date(stamp).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

/**
 * The calendar date it currently is in `timeZone`.
 *
 * formatToParts rather than slicing format(): the 'en-CA' short date happens to
 * render as YYYY-MM-DD today, but that is ICU locale data, not a guarantee, and
 * a silent change of separator would corrupt every date in the app. Reading the
 * named parts cannot drift.
 */
export function todayIn(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const part = (type) => parts.find((candidate) => candidate.type === type)?.value ?? "";

  return `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
}

/**
 * The application's today. Every feature that needs to know the current date
 * calls this, so they all agree and all move together when the zone changes.
 */
export function today() {
  return todayIn(config.timezone);
}

/**
 * The wall-clock time it currently is in `timeZone`, as 'HH:MM'.
 *
 * The same reasoning as todayIn, and the same construction: named parts rather
 * than a sliced format(), and hourCycle 'h23' because 'en-CA' renders midnight
 * as 24:00 under h24 — an hour that sorts after everything and exists on no
 * clock. 'HH:MM' compares lexicographically, which is what lets a reminder time
 * be tested against now with <= and no parsing, exactly as dates are.
 */
export function timeIn(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date());

  const part = (type) => parts.find((candidate) => candidate.type === type)?.value ?? "";

  return `${part("hour").padStart(2, "0")}:${part("minute").padStart(2, "0")}`;
}

/**
 * The application's current time of day. Reminders are the only thing that asks
 * — everything else here is about calendar days — and it belongs in this file
 * for the same reason today() does: nothing outside it may read a clock.
 */
export function nowTime() {
  return timeIn(config.timezone);
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export function addDays(iso, days) {
  return fromStamp(requireStamp(iso) + days * DAY_MS);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from, to) {
  return Math.round((requireStamp(to) - requireStamp(from)) / DAY_MS);
}

/** ISO-8601 weekday: 1 = Monday ... 7 = Sunday, matching Postgres ISODOW. */
export function isoWeekday(iso) {
  return new Date(requireStamp(iso)).getUTCDay() || 7;
}

/** The Monday of the week containing `iso`. The product's weeks start Monday. */
export function startOfWeek(iso) {
  return addDays(iso, -(isoWeekday(iso) - 1));
}

/** The Sunday of the week containing `iso`. */
export function endOfWeek(iso) {
  return addDays(iso, 7 - isoWeekday(iso));
}

/** Every date from `from` to `to` inclusive, oldest first. Empty when reversed. */
export function eachDay(from, to) {
  const last = requireStamp(to);
  const out = [];
  for (let stamp = requireStamp(from); stamp <= last; stamp += DAY_MS) {
    out.push(fromStamp(stamp));
  }
  return out;
}

/** The 'YYYY-MM' month a date falls in. */
export function monthOf(iso) {
  requireStamp(iso);
  return iso.slice(0, 7);
}

/** Shifts a 'YYYY-MM' month. Month arithmetic only — no day to land wrongly. */
export function addMonths(isoMonth, months) {
  if (!isIsoMonth(isoMonth)) {
    throw new TypeError(`Not a calendar month: ${JSON.stringify(isoMonth)}`);
  }
  const [year, month] = isoMonth.split("-").map(Number);
  return fromStamp(Date.UTC(year, month - 1 + months, 1, 12)).slice(0, 7);
}

/** First and last calendar date of a 'YYYY-MM' month. */
export function monthRange(isoMonth) {
  if (!isIsoMonth(isoMonth)) {
    throw new TypeError(`Not a calendar month: ${JSON.stringify(isoMonth)}`);
  }
  const start = `${isoMonth}-01`;
  const [year, month] = isoMonth.split("-").map(Number);
  // Day 0 of the next month is the last day of this one, leap years included.
  return { start, end: fromStamp(Date.UTC(year, month, 0, 12)) };
}

/**
 * An event instant on a given calendar day, as an ISO timestamp.
 *
 * Only for deriving TIMESTAMPTZ values from a calendar offset — the seed's
 * archived_at and completed_at. Real events stamp themselves with now().
 */
export function instantOn(iso) {
  return new Date(requireStamp(iso)).toISOString();
}
