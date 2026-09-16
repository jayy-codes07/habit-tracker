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
import { addDays, startOfWeek, today } from "../../lib/dates.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";

/**
 * archived_at is an instant; the grid needs the calendar day it happened on, in
 * the app's own time zone. Casting in the server's zone instead would put the
 * boundary in the wrong place for anyone not living in UTC.
 */
const ARCHIVED_ON = "(h.archived_at AT TIME ZONE $1)::date AS archived_on";

/** Any log of this habit that carries a measurement. */
const HAS_VALUES = `EXISTS (SELECT 1 FROM habit_logs l
                             WHERE l.habit_id = h.id AND l.value IS NOT NULL)`;

/** Any schedule version of this habit that ever asked for an amount. */
const HAS_TARGETS = `EXISTS (SELECT 1 FROM habit_schedules s
                              WHERE s.habit_id = h.id AND s.target_value IS NOT NULL)`;

/**
 * Whether the habit's unit is now frozen.
 *
 * The unit may be changed freely until the habit has recorded a number in it,
 * and never afterwards — because every such number is in that unit and no row
 * records which, so changing it re-means all of them at once.
 *
 * Two kinds of number count, not one. Measured values are the obvious kind. The
 * other is the **target**, which is history too: a version that asked for 5 km
 * is a record of what was wanted that week, and turning the unit into miles
 * makes the past say "5 miles" — a sentence nobody ever wrote. Locking on
 * values alone let exactly that happen, silently, on a habit that simply had
 * not been logged yet.
 *
 * Clearing the unit is the one change this does not govern; see updateHabit.
 *
 * The client cannot work any of this out — it would have to hold the habit's
 * whole log and version history — so the server reports it, and still refuses
 * an illegal change rather than trusting the answer to come back honestly.
 *
 * `h.unit IS NOT NULL` is not decoration. A binary habit's unit is not locked,
 * it is absent — it can hold no target (insertVersion refuses one) and no value
 * (setLog refuses one), so there is nothing to freeze. Saying so here is also
 * what keeps the answer right in updateHabit's RETURNING, which shares a
 * snapshot with the CTE that clears the targets and so still counts them:
 * RETURNING reports the *new* unit, and a habit that has just gone binary is
 * unlocked whatever that snapshot says about rows it is in the act of emptying.
 */
const UNIT_LOCKED = `(h.unit IS NOT NULL AND (${HAS_VALUES} OR ${HAS_TARGETS})) AS unit_locked`;

const HABIT_COLUMNS = `h.id, h.name, h.color_token, h.sort_order, h.start_date, h.unit,
                       h.archived_at, ${ARCHIVED_ON}, ${UNIT_LOCKED}`;

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
    // ::float8 rather than raw numeric: node-postgres returns numeric as a
    // *string*, exactly as it does bigint, and there is no type-parser override
    // for it. A string target reaches the client as "5.00" and, worse, compares
    // as text — "3.00" >= "10.00" is true. numeric(10,2) is well inside float8's
    // exact range, so the cast loses nothing and removes the whole trap.
    `SELECT habit_id, effective_from, schedule_kind, schedule_days, weekly_target,
            target_value::float8 AS target_value
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

/**
 * Measured amounts for these habits within a date range, as
 * Map<habitId, Map<date, number>>.
 *
 * A second, narrower query rather than a fourth column on loadLogs, and the
 * reason is the window each one needs. A streak is only as correct as the whole
 * history behind it, so loadLogs runs from the earliest start_date; attainment
 * is asked for over one month. Widening loadLogs would drag a value for every
 * log the habit has ever had through a query whose comment exists to say that
 * it must not carry anything the arithmetic does not look at.
 *
 * The other half of the reason is shape: the map this feeds is a *sibling* of
 * `logs`, never a widening of it, so every function in lib/streaks.js keeps
 * consuming Map<date, status> and needs no change to support quantity.
 */
export async function loadLogValues(habitIds, from, to) {
  if (habitIds.length === 0) return new Map();

  const { rows } = await query(
    `SELECT habit_id, date, value::float8 AS value
       FROM habit_logs
      WHERE habit_id = ANY($1::bigint[])
        AND date BETWEEN $2 AND $3
        AND value IS NOT NULL`,
    [habitIds, from, to],
  );

  const byHabit = new Map(habitIds.map((id) => [id, new Map()]));
  for (const row of rows) byHabit.get(row.habit_id)?.set(row.date, row.value);
  return byHabit;
}

/**
 * One habit's written days, newest first, a page at a time.
 *
 * The one query in this module that returns notes in bulk, and the reason the
 * habit history screen can exist at all: a note is up to 1000 characters per
 * habit per day, and until now it was readable one date at a time.
 *
 * `before` is a cursor rather than an offset, and it is free: habit_logs is
 * UNIQUE (habit_id, date), so "this habit, older than that day, newest first"
 * is a backward scan of that index and nothing is counted or skipped. A page is
 * also stable while the history is being edited, which an offset is not.
 *
 * One row more than asked for is fetched so the caller can say whether there is
 * an older page without a second COUNT over the whole history.
 */
export async function loadNotes(habitId, { before = null, limit = 30 } = {}) {
  const { rows } = await query(
    `SELECT date, status, value::float8 AS value, note
       FROM habit_logs
      WHERE habit_id = $1
        AND note IS NOT NULL
        AND ($2::date IS NULL OR date < $2)
      ORDER BY date DESC
      LIMIT $3`,
    [habitId, before, limit + 1],
  );

  return { notes: rows.slice(0, limit), more: rows.length > limit };
}

/** Full log rows for one day, where the note and the amount matter — the day screen. */
export async function loadDayLogs(date) {
  const { rows } = await query(
    "SELECT habit_id, date, status, value::float8 AS value, note FROM habit_logs WHERE date = $1",
    [date],
  );
  return new Map(rows.map((row) => [row.habit_id, row]));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Said by both callers of insertVersion, because its unit gate can refuse
 * either one and the sentence is the same either way: a target is a number in
 * a unit, and a habit without one has nothing to express it in.
 */
const TARGET_NEEDS_UNIT =
  "Only a habit with a unit can have a target. Give this habit a unit first.";

/**
 * A habit and its first schedule version.
 *
 * One of the two operations that needs a transaction: a habit with no schedule
 * version resolves to nothing on every date, which is not a state the rest of
 * the app can render or reason about.
 *
 * Which is precisely why insertVersion's answer is checked. It returns null
 * when its unit gate refuses a target on a habit with no unit, and the habit
 * row is already inserted by then — so ignoring that null commits exactly the
 * state the transaction is here to prevent: a habit that is inactive on every
 * screen, for ever, with nothing to say why. Throwing rolls both rows back.
 *
 * No probe for a missing habit, unlike setSchedule: this one was inserted two
 * statements ago, so the gate is the only thing that can have refused.
 */
export function createHabit({ name, colorToken, startDate, unit, schedule }) {
  return withTransaction(async () => {
    const { rows } = await query(
      `INSERT INTO habits (name, color_token, start_date, unit, sort_order)
       VALUES ($1, $2, $3, $4,
               COALESCE((SELECT max(sort_order) + 1 FROM habits WHERE archived_at IS NULL), 1))
       RETURNING id`,
      [name, colorToken, startDate, unit ?? null],
    );
    const id = rows[0].id;

    if (!(await insertVersion(id, startDate, schedule))) throw badRequest(TARGET_NEEDS_UNIT);
    return loadHabit(id);
  });
}

/**
 * Partial update of the presentation fields, plus archiving.
 *
 * COALESCE rather than a dynamically built SET list: both columns are NOT NULL,
 * so "leave it alone" and "set it to null" can never be confused, and the query
 * stays one fixed string with no interpolation.
 *
 * `unit` cannot use COALESCE, and the reason is the sentence above: the trick
 * works precisely because name and color_token are NOT NULL, so "leave it alone"
 * and "set it to null" can never be confused. unit is nullable and clearing it
 * is a real request, so it needs a flag saying whether the caller mentioned it
 * at all — `unitGiven` — rather than reading a null as silence.
 *
 * The WHERE clause carries the immutability rule (see UNIT_LOCKED): the unit is
 * refused once any log of this habit holds a value **or** any version of it
 * holds a target, because every one of those numbers is in the old unit and no
 * row records which unit it was — changing it turns them into two different
 * quantities under one label. The guard rides on the UPDATE rather than
 * preceding it so that the check and the write share one snapshot, the same
 * reason deleteHabit is one statement. Re-sending the unit it already has is not
 * a change and is always allowed.
 *
 * Clearing is the exception, and only to the target half: a habit going binary
 * loses its targets in this very statement, so there is nothing left for a
 * future unit to re-mean. Measured values are not so forgiving — they stay — so
 * clearing is refused while any exists, exactly as every other change is.
 *
 * Clearing the unit takes every stored target with it, in the same statement.
 * "A target requires a unit" spans two tables, so no CHECK can hold it and
 * insertVersion carries it on the write path — but clearing the unit attacks
 * the same invariant from the other side, and left the habit binary with
 * `target_value` still on its versions. That state is not merely untidy:
 *
 *   - the schedule became unsavable, because the editor reads the orphan target
 *     back into its draft and sends it to a gate that now refuses it, in a
 *     field the habit no longer shows;
 *   - re-adding a *different* unit silently re-meant it — 5 km becoming 5 miles
 *     without anyone typing 5.
 *
 * A data-modifying CTE rather than a transaction, following deleteHabit: both
 * halves share one snapshot and land together or not at all, so no connection
 * leaves the pool and there is no window where the unit is gone and the target
 * is not. `target_value IS NOT NULL` keeps the update off versions that never
 * had one, so a paused version and an untargeted one keep their updated_at —
 * everything but the target is preserved, and no log is touched at all.
 *
 * Restoring an archived habit re-numbers it to the end of the active list, the
 * same way createHabit numbers a new one. A habit keeps its sort_order while it
 * is archived, and the number it left behind is handed out again by the next
 * habit created, so a restore that kept the old value would put two active
 * habits on the same one. Nothing then breaks loudly — ORDER BY sort_order, id
 * still returns a stable list, and the next reorder renumbers everything — but
 * the two habits are ranked by an id tiebreak nobody can see or change, and the
 * restored habit reappears in the middle of the list rather than where putting
 * something back would suggest. Coming back at the end is also the honest
 * reading: the list is a running order of what you are tracking now.
 */
export async function updateHabit(id, { name, colorToken, archived, unit, unitGiven = false }) {
  const { rows } = await query(
    `WITH updated AS (
       UPDATE habits h
          SET name        = COALESCE($3, h.name),
              color_token = COALESCE($4, h.color_token),
              unit        = CASE WHEN $6::boolean THEN $7 ELSE h.unit END,
              archived_at = CASE
                WHEN $5::boolean IS NULL THEN h.archived_at
                -- Re-archiving keeps the original moment; it is not a new event.
                WHEN $5 THEN COALESCE(h.archived_at, now())
                ELSE NULL
              END,
              sort_order = CASE
                -- Only an actual restore. Patching archived:false on a habit
                -- that is already active is a no-op and must not shuffle it to
                -- the end.
                WHEN $5::boolean IS FALSE AND h.archived_at IS NOT NULL
                  THEN COALESCE((SELECT max(sort_order) + 1 FROM habits
                                  WHERE archived_at IS NULL), 1)
                ELSE h.sort_order
              END
        WHERE h.id = $2
          AND (
            NOT $6::boolean
            OR $7 IS NOT DISTINCT FROM h.unit
            OR (
              NOT ${HAS_VALUES}
              -- Clearing is exempt from the target half of the rule, and only
              -- from that half. It cannot leave a target behind to be re-meant,
              -- because the CTE below takes every one of them with it — whereas
              -- swapping km for miles would leave them all in place, saying
              -- something nobody said.
              AND ($7 IS NULL OR NOT ${HAS_TARGETS})
            )
          )
        RETURNING ${HABIT_COLUMNS}
     ),
     -- The habit is binary from here, so nothing may still be aiming at a
     -- number. Reads from the CTE above, so it runs only on an accepted update
     -- and never on a refused one.
     unaimed AS (
       UPDATE habit_schedules s
          SET target_value = NULL
        WHERE s.habit_id = (SELECT id FROM updated)
          AND $6::boolean
          AND $7::text IS NULL
          AND s.target_value IS NOT NULL
     )
     SELECT * FROM updated`,
    [config.timezone, id, name ?? null, colorToken ?? null, archived ?? null, unitGiven, unit],
  );

  if (rows.length > 0) return rows[0];

  // Zero rows means either no such habit or a refused unit change, and only the
  // wording differs — the write has already not happened either way, so this
  // second read decides which message to send and nothing else. It also says
  // *which* history did the locking, because "measured values" is simply untrue
  // of a habit that has only ever had a target, and a reason that does not match
  // what you can see on the screen is worse than no reason at all.
  const { rows: probe } = await query(
    `SELECT ${HAS_VALUES} AS measured FROM habits h WHERE id = $1`,
    [id],
  );
  if (probe.length === 0) throw notFound("No such habit");

  throw conflict(
    `${
      probe[0].measured
        ? "This habit has days measured in its unit"
        : "This habit has targets set in its unit"
    }, so the unit can no longer be changed. ` +
      "Archive it and start a new one to measure in something else.",
  );
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

/** The two scoring units. Pausing is not one — it asks for nothing. */
const UNITS = new Set(["fixed", "weekly"]);

/** The schedule kind in force on `date`, or null before the first version. */
async function kindInForce(habitId, date) {
  const { rows } = await query(
    `SELECT schedule_kind
       FROM habit_schedules
      WHERE habit_id = $1 AND effective_from <= $2
      ORDER BY effective_from DESC
      LIMIT 1`,
    [habitId, date],
  );
  return rows[0]?.schedule_kind ?? null;
}

/**
 * The date a version should actually start on.
 *
 * A change of scoring *unit* — fixed to weekly or back — waits for the following
 * Monday. The two units measure different periods, and a change landing on a
 * Thursday leaves a week that is half a set of named days and half a count over
 * seven of them: neither a complete fixed period nor a complete weekly one, and
 * so honestly scoreable as neither. Deferring to the week boundary means the
 * unit never changes inside a period, which is why no scoring read carries a
 * special case for it — the rule is enforced once, here, where it is also
 * visible to the user as the effective_from that comes back.
 *
 * Everything else starts when it was asked to:
 *
 *   fixed to fixed   only renames the days, and every day is still scored under
 *                    the version in force on it.
 *   a target change  is already handled by the week taking the target in force
 *                    on its first active day, which a mid-week edit cannot move.
 *   pause, resume    must be immediate — you pause because you are ill today —
 *                    and a week a pause splits is already provisional.
 */
function effectiveDateFor(currentKind, nextKind, requested) {
  if (currentKind === nextKind) return requested;
  if (!UNITS.has(currentKind) || !UNITS.has(nextKind)) return requested;

  const monday = startOfWeek(requested);
  // A change already dated to a Monday starts a period of its own.
  return monday === requested ? monday : addDays(monday, 7);
}

/**
 * Appends a schedule version, or corrects one that has not been lived yet.
 *
 * Backdating is refused: rewriting a version that is already in the past would
 * re-score history, which is the whole thing the versioned schedule exists to
 * prevent. Today and later are fair game, and the upsert is what makes fixing a
 * schedule you just set possible at all — the unique constraint on
 * (habit_id, effective_from) would otherwise turn a correction into a 409.
 *
 * The stored effective_from is not always the one asked for: see
 * effectiveDateFor. It is returned, so the caller always learns the answer.
 */
export async function setSchedule(habitId, effectiveFrom, schedule) {
  if (effectiveFrom < today()) {
    throw badRequest("A schedule change cannot start in the past");
  }

  const from = effectiveDateFor(
    await kindInForce(habitId, effectiveFrom),
    schedule.kind,
    effectiveFrom,
  );

  const version = await insertVersion(habitId, from, schedule);
  if (version) return version;

  // The insert selects from habits, so zero rows means the habit is missing or
  // it is binary and a target was sent at it. Same shape as updateHabit's probe,
  // and for the same reason: nothing was written either way.
  const { rows } = await query("SELECT unit FROM habits WHERE id = $1", [habitId]);
  if (rows.length === 0) throw notFound("No such habit");

  throw badRequest(TARGET_NEEDS_UNIT);
}

/**
 * The habit filter is doing two jobs. `WHERE id = $1` is the one it has always
 * done — an unknown id yields zero rows instead of a foreign-key violation, so
 * the caller answers 404 without anyone mapping SQLSTATE 23503. The unit check
 * is the second: "a target requires a unit" spans two tables, so no CHECK can
 * hold it, and doing it here keeps it in the same statement as the write rather
 * than in a read that could go stale between the two.
 */
async function insertVersion(habitId, effectiveFrom, { kind, days, weeklyTarget, targetValue }) {
  const { rows } = await query(
    `INSERT INTO habit_schedules
       (habit_id, effective_from, schedule_kind, schedule_days, weekly_target, target_value)
     SELECT id, $2, $3, $4, $5, $6 FROM habits
      WHERE id = $1 AND ($6::numeric IS NULL OR unit IS NOT NULL)
     ON CONFLICT (habit_id, effective_from) DO UPDATE
        SET schedule_kind = EXCLUDED.schedule_kind,
            schedule_days = EXCLUDED.schedule_days,
            weekly_target = EXCLUDED.weekly_target,
            -- Load-bearing. The SET list is exhaustive, not a patch: leave
            -- target_value out and correcting a schedule on the day you set it
            -- keeps the old target on a row that looks freshly written.
            target_value  = EXCLUDED.target_value
     RETURNING effective_from, schedule_kind, schedule_days, weekly_target,
               target_value::float8 AS target_value`,
    [habitId, effectiveFrom, kind, days ?? null, weeklyTarget ?? null, targetValue ?? null],
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
export async function setLog(habitId, date, { status, value, note }) {
  if (date > today()) throw badRequest("A habit cannot be logged for a future day");

  const { rows } = await query(
    `INSERT INTO habit_logs (habit_id, date, status, value, note)
     SELECT id, $2, $3, $4, $5 FROM habits
      WHERE id = $1 AND ($4::numeric IS NULL OR unit IS NOT NULL)
     ON CONFLICT (habit_id, date) DO UPDATE
        -- A replace, not a patch: an omitted value clears the old one, exactly
        -- as an omitted note already does. Preserving it instead would let a
        -- status change strand a measurement from a different claim — and could
        -- carry a legal missed + 0 into an illegal done + 0.
        SET status = EXCLUDED.status, value = EXCLUDED.value, note = EXCLUDED.note
     RETURNING habit_id, date, status, value::float8 AS value, note`,
    [habitId, date, status, value ?? null, note ?? null],
  );

  if (rows.length > 0) return rows[0];

  const { rows: probe } = await query("SELECT unit FROM habits WHERE id = $1", [habitId]);
  if (probe.length === 0) throw notFound("No such habit");

  throw badRequest("Only a habit with a unit can record a measured value.");
}

/**
 * Removes the row entirely, returning the day to "never logged" — a state that
 * is distinct from missed and needs a way back. Idempotent: clearing a day that
 * was never logged is already the requested outcome.
 */
export async function clearLog(habitId, date) {
  await query("DELETE FROM habit_logs WHERE habit_id = $1 AND date = $2", [habitId, date]);
}
