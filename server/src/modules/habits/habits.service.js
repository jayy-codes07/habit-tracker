/**
 * Habits, their schedule versions, and their logs.
 *
 * One module rather than three: a schedule version and a log have no life of
 * their own: both exist only as part of a habit, are reached only through one,
 * and die with it. Splitting them would buy three routers and a lot of
 * cross-importing for nothing.
 *
 * Almost everything here is a single statement, which Postgres already runs
 * atomically — wrapping those in withTransaction would take a connection out of
 * a pool of ten and add two round trips to buy nothing. Only two operations
 * genuinely need one, and they say so.
 */
import { config } from "../../config/index.js";
import { query, withTransaction } from "../../db/index.js";
import { today } from "../../lib/dates.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";

/**
 * archived_at is an instant; the grid needs the calendar day it happened on, in
 * the app's own time zone. Casting in the server's zone instead would put the
 * boundary in the wrong place for anyone not living in UTC.
 */
const ARCHIVED_ON = "(h.archived_at AT TIME ZONE $1)::date AS archived_on";

const HABIT_COLUMNS = `h.id, h.name, h.color_token, h.sort_order, h.start_date,
                       h.archived_at, ${ARCHIVED_ON}`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Habits in display order. Archived ones are excluded unless asked for. */
export async function loadHabits({ includeArchived = false } = {}) {
  const { rows } = await query(
    `SELECT ${HABIT_COLUMNS}
       FROM habits h
      WHERE $2::boolean OR h.archived_at IS NULL
      ORDER BY h.sort_order, h.id`,
    [config.timezone, includeArchived],
  );
  return rows;
}

export async function loadHabit(id) {
  const { rows } = await query(`SELECT ${HABIT_COLUMNS} FROM habits h WHERE h.id = $2`, [
    config.timezone,
    id,
  ]);
  return rows[0] ?? null;
}

/**
 * Every schedule version for these habits, grouped by habit id and ascending by
 * effective_from — the order resolveSchedule() walks. Versions are few (a habit
 * has a handful in its whole life), so they are always loaded whole rather than
 * resolved per day in SQL.
 */
export async function loadVersions(habitIds) {
  if (habitIds.length === 0) return new Map();

  const { rows } = await query(
    `SELECT habit_id, effective_from, schedule_kind, schedule_days, weekly_target
       FROM habit_schedules
      WHERE habit_id = ANY($1::bigint[])
      ORDER BY habit_id, effective_from`,
    [habitIds],
  );

  const byHabit = new Map(habitIds.map((id) => [id, []]));
  for (const row of rows) byHabit.get(row.habit_id)?.push(row);
  return byHabit;
}

/**
 * Logs for these habits within a date range, as Map<habitId, Map<date, status>>.
 *
 * Deliberately only three columns: a streak needs the habit's whole history, and
 * selecting the note and value along with it would move far more data than the
 * arithmetic ever looks at.
 */
export async function loadLogs(habitIds, from, to) {
  if (habitIds.length === 0) return new Map();

  const { rows } = await query(
    `SELECT habit_id, date, status
       FROM habit_logs
      WHERE habit_id = ANY($1::bigint[])
        AND date BETWEEN $2 AND $3`,
    [habitIds, from, to],
  );

  const byHabit = new Map(habitIds.map((id) => [id, new Map()]));
  for (const row of rows) byHabit.get(row.habit_id)?.set(row.date, row.status);
  return byHabit;
}

/** Full log rows for one day, where the note matters — the day screen. */
export async function loadDayLogs(date) {
  const { rows } = await query(
    "SELECT habit_id, date, status, note FROM habit_logs WHERE date = $1",
    [date],
  );
  return new Map(rows.map((row) => [row.habit_id, row]));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * A habit and its first schedule version.
 *
 * One of the two operations that needs a transaction: a habit with no schedule
 * version resolves to nothing on every date, which is not a state the rest of
 * the app can render or reason about.
 */
export function createHabit({ name, colorToken, startDate, schedule }) {
  return withTransaction(async () => {
    const { rows } = await query(
      `INSERT INTO habits (name, color_token, start_date, sort_order)
       VALUES ($1, $2, $3,
               COALESCE((SELECT max(sort_order) + 1 FROM habits WHERE archived_at IS NULL), 1))
       RETURNING id`,
      [name, colorToken, startDate],
    );
    const id = rows[0].id;

    await insertVersion(id, startDate, schedule);
    return loadHabit(id);
  });
}

/**
 * Partial update of the presentation fields, plus archiving.
 *
 * COALESCE rather than a dynamically built SET list: both columns are NOT NULL,
 * so "leave it alone" and "set it to null" can never be confused, and the query
 * stays one fixed string with no interpolation.
 */
export async function updateHabit(id, { name, colorToken, archived }) {
  const { rows } = await query(
    `UPDATE habits h
        SET name        = COALESCE($3, h.name),
            color_token = COALESCE($4, h.color_token),
            archived_at = CASE
              WHEN $5::boolean IS NULL THEN h.archived_at
              -- Re-archiving keeps the original moment; it is not a new event.
              WHEN $5 THEN COALESCE(h.archived_at, now())
              ELSE NULL
            END
      WHERE h.id = $2
      RETURNING ${HABIT_COLUMNS}`,
    [config.timezone, id, name ?? null, colorToken ?? null, archived ?? null],
  );

  if (rows.length === 0) throw notFound("No such habit");
  return rows[0];
}

/**
 * Deletes a habit, but only one that has no history.
 *
 * habit_logs cascades, so an unguarded delete destroys months of data with no
 * undo. The rule is: you can delete a mistake, you must archive a history.
 *
 * One statement, deliberately, rather than a check followed by a delete — that
 * pair leaves a window in which a log written between the two is destroyed by
 * the cascade. Here the guard and the delete share a snapshot, and a concurrent
 * INSERT into habit_logs takes a FOR KEY SHARE lock on this very row, which the
 * DELETE's own lock conflicts with, so the two serialise.
 */
export async function deleteHabit(id) {
  const { rows } = await query(
    `WITH victim AS (
       DELETE FROM habits
        WHERE id = $1
          AND NOT EXISTS (SELECT 1 FROM habit_logs WHERE habit_id = habits.id)
       RETURNING id
     )
     SELECT EXISTS (SELECT 1 FROM victim)                         AS deleted,
            EXISTS (SELECT 1 FROM habits     WHERE id = $1)       AS existed,
            EXISTS (SELECT 1 FROM habit_logs WHERE habit_id = $1) AS has_logs`,
    [id],
  );

  const { deleted, existed, has_logs: hasLogs } = rows[0];
  if (deleted) return;
  if (!existed) throw notFound("No such habit");
  if (hasLogs) {
    throw conflict("This habit has logged history. Archive it instead of deleting it.");
  }
  // Not reachable: not deleted, exists, and has no logs is a contradiction.
  throw conflict("Could not delete this habit");
}

/**
 * Rewrites display order from a complete list of active habit ids.
 *
 * The other operation that needs a transaction. The UPDATE itself is one
 * statement, but it is rejected afterwards when the list does not match the
 * active habits exactly, and without a transaction that rejection would leave
 * the half-applied order behind.
 */
export function reorderHabits(ids) {
  return withTransaction(async () => {
    const { rows } = await query("SELECT id FROM habits WHERE archived_at IS NULL");
    const active = new Set(rows.map((row) => row.id));

    const given = new Set(ids);
    if (given.size !== ids.length) throw badRequest("Duplicate habit ids in the order");
    if (given.size !== active.size || [...given].some((id) => !active.has(id))) {
      throw badRequest("The order must list every active habit exactly once");
    }

    await query(
      `UPDATE habits AS h
          SET sort_order = ordered.position
         FROM unnest($1::bigint[]) WITH ORDINALITY AS ordered(id, position)
        WHERE h.id = ordered.id`,
      [ids],
    );

    return loadHabits();
  });
}

/**
 * Appends a schedule version, or corrects one that has not been lived yet.
 *
 * Backdating is refused: rewriting a version that is already in the past would
 * re-score history, which is the whole thing the versioned schedule exists to
 * prevent. Today and later are fair game, and the upsert is what makes fixing a
 * schedule you just set possible at all — the unique constraint on
 * (habit_id, effective_from) would otherwise turn a correction into a 409.
 */
export async function setSchedule(habitId, effectiveFrom, schedule) {
  if (effectiveFrom < today()) {
    throw badRequest("A schedule change cannot start in the past");
  }

  const version = await insertVersion(habitId, effectiveFrom, schedule);
  if (!version) throw notFound("No such habit");
  return version;
}

async function insertVersion(habitId, effectiveFrom, { kind, days, weeklyTarget }) {
  const { rows } = await query(
    `INSERT INTO habit_schedules (habit_id, effective_from, schedule_kind, schedule_days, weekly_target)
     SELECT id, $2, $3, $4, $5 FROM habits WHERE id = $1
     ON CONFLICT (habit_id, effective_from) DO UPDATE
        SET schedule_kind = EXCLUDED.schedule_kind,
            schedule_days = EXCLUDED.schedule_days,
            weekly_target = EXCLUDED.weekly_target
     RETURNING effective_from, schedule_kind, schedule_days, weekly_target`,
    [habitId, effectiveFrom, kind, days ?? null, weeklyTarget ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Sets the status for one day.
 *
 * INSERT ... SELECT FROM habits rather than a plain INSERT: it makes an unknown
 * habit id return zero rows instead of a foreign-key violation, so the caller
 * gets a 404 without anyone having to map SQLSTATE 23503, and without a separate
 * existence check.
 */
export async function setLog(habitId, date, { status, note }) {
  if (date > today()) throw badRequest("A habit cannot be logged for a future day");

  const { rows } = await query(
    `INSERT INTO habit_logs (habit_id, date, status, note)
     SELECT id, $2, $3, $4 FROM habits WHERE id = $1
     ON CONFLICT (habit_id, date) DO UPDATE
        SET status = EXCLUDED.status, note = EXCLUDED.note
     RETURNING habit_id, date, status, note`,
    [habitId, date, status, note ?? null],
  );

  if (rows.length === 0) throw notFound("No such habit");
  return rows[0];
}

/**
 * Removes the row entirely, returning the day to "never logged" — a state that
 * is distinct from missed and needs a way back. Idempotent: clearing a day that
 * was never logged is already the requested outcome.
 */
export async function clearLog(habitId, date) {
  await query("DELETE FROM habit_logs WHERE habit_id = $1 AND date = $2", [habitId, date]);
}
