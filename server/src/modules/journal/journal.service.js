/**
 * Journal entries: daily one-liners and monthly reflections.
 *
 * Two kinds share one table, keyed by (date, kind). A monthly entry is anchored
 * to the first of its month, which journal_month_anchored enforces, so the two
 * kinds can coexist on the 1st without colliding.
 *
 * There is no "save an empty entry": journal_entry_not_blank makes an empty
 * string unstorable, so clearing an entry is a DELETE. That is the API's
 * contract too — the UI's "cleared the box and saved" maps to remove().
 */
import { query } from "../../db/index.js";
import { monthRange } from "../../lib/dates.js";

/** The first of the month is where a monthly reflection lives. */
export const monthAnchor = (isoMonth) => monthRange(isoMonth).start;

export async function loadEntry(date, kind) {
  const { rows } = await query(
    "SELECT date, kind, entry, updated_at FROM journal WHERE date = $1 AND kind = $2",
    [date, kind],
  );
  return rows[0] ?? null;
}

/** Every daily entry in a date range, oldest first — the monthly review's list. */
export async function loadDayEntries(from, to) {
  const { rows } = await query(
    `SELECT date, kind, entry, updated_at
       FROM journal
      WHERE kind = 'day' AND date BETWEEN $1 AND $2
      ORDER BY date`,
    [from, to],
  );
  return rows;
}

export async function saveEntry(date, kind, entry) {
  const { rows } = await query(
    `INSERT INTO journal (date, kind, entry)
     VALUES ($1, $2, $3)
     ON CONFLICT (date, kind) DO UPDATE SET entry = EXCLUDED.entry
     RETURNING date, kind, entry, updated_at`,
    [date, kind, entry],
  );
  return rows[0];
}

/** Idempotent: clearing an entry that was never written is the same outcome. */
export async function removeEntry(date, kind) {
  await query("DELETE FROM journal WHERE date = $1 AND kind = $2", [date, kind]);
}
