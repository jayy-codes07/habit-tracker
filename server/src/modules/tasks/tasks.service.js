/**
 * Tasks.
 *
 * There is no hard delete. Removing a task means archiving it, the same gesture
 * habits use, so nothing a single tap does is irreversible and the export stays
 * complete. A habit needs a delete escape hatch because it accumulates dependent
 * log rows; a task has no dependents, so an archived typo costs one row nobody
 * ever sees.
 *
 * Every read here filters archived_at IS NULL. That is a correctness
 * requirement, not an optimisation: tasks_due_date_open_idx is partial on
 * `WHERE NOT completed` and says nothing about archiving, so an archived task
 * that was never completed would otherwise reappear as overdue for ever.
 */
import { config } from "../../config/index.js";
import { query } from "../../db/index.js";
import { notFound } from "../../lib/errors.js";

const COLUMNS = "id, title, due_date, completed, completed_at, created_at, archived_at";

/**
 * archived_at is an instant; a recovery list wants the calendar day it fell on,
 * in the app's own zone — the same cast habits.service.js makes for its own
 * archived_on, and for the same reason. Slicing the instant's ISO string on the
 * client instead would pin the label to UTC, which is nobody's calendar: a task
 * removed at 05:00 in UTC+05:30 was removed the previous day according to Z.
 *
 * Only the archived read selects it. Every other read filters archived_at IS
 * NULL, so the column would be null in all of them and the cast would buy a
 * bound parameter for nothing.
 */
const ARCHIVED_ON = "(archived_at AT TIME ZONE $1)::date AS archived_on";

/**
 * Open tasks by default; `includeCompleted` adds completed ones. Neither ever
 * returns an archived task.
 *
 * `archived` is the mirror image and the only way back to a removed task: every
 * archived one, whether it was finished or not. It is ordered most recently
 * removed first because that is what a recovery list is for — due date and
 * completion rank a task among things you still intend to do, which is exactly
 * what these are not. A separate statement rather than a CASE in ORDER BY: the
 * two lists answer different questions and share only their columns.
 */
export async function loadTasks({ includeCompleted = false, archived = false } = {}) {
  if (archived) {
    const { rows } = await query(
      `SELECT ${COLUMNS}, ${ARCHIVED_ON}
         FROM tasks
        WHERE archived_at IS NOT NULL
        ORDER BY archived_at DESC, id DESC`,
      [config.timezone],
    );
    return rows;
  }

  const { rows } = await query(
    `SELECT ${COLUMNS}
       FROM tasks
      WHERE archived_at IS NULL
        AND ($1::boolean OR NOT completed)
      ORDER BY completed, due_date NULLS LAST, created_at`,
    [includeCompleted],
  );
  return rows;
}

/**
 * The two lists the day screen needs, in one round trip.
 *
 * Overdue is simply "open and due before this day", with no special case for
 * today: nothing is rolled forward and no due date is ever rewritten, so a task
 * keeps saying when it was actually meant to happen.
 */
export async function loadTasksForDay(date) {
  const { rows } = await query(
    `SELECT ${COLUMNS},
            (due_date < $1 AND NOT completed) AS overdue
       FROM tasks
      WHERE archived_at IS NULL
        AND due_date IS NOT NULL
        AND (due_date = $1 OR (due_date < $1 AND NOT completed))
      ORDER BY due_date, created_at`,
    [date],
  );

  return {
    due: rows.filter((row) => !row.overdue).map(strip),
    overdue: rows.filter((row) => row.overdue).map(strip),
  };
}

const strip = ({ overdue: _overdue, ...task }) => task;

export async function createTask({ title, dueDate }) {
  const { rows } = await query(
    `INSERT INTO tasks (title, due_date) VALUES ($1, $2) RETURNING ${COLUMNS}`,
    [title, dueDate ?? null],
  );
  return rows[0];
}

/**
 * Partial update, including completing and archiving.
 *
 * completed and completed_at are set in the same statement because
 * tasks_completed_consistent forbids them from ever disagreeing. Re-completing
 * an already-completed task keeps the original moment rather than moving it.
 *
 * due_date is the one nullable field, so it needs a separate "was it sent at
 * all" flag: COALESCE cannot tell "leave it alone" from "clear it".
 */
export async function updateTask(id, { title, dueDate, dueDateGiven, completed, archived }) {
  const { rows } = await query(
    `UPDATE tasks
        SET title    = COALESCE($2, title),
            due_date = CASE WHEN $3::boolean THEN $4::date ELSE due_date END,
            completed = COALESCE($5::boolean, completed),
            completed_at = CASE
              WHEN $5::boolean IS NULL THEN completed_at
              WHEN $5 THEN COALESCE(completed_at, now())
              ELSE NULL
            END,
            archived_at = CASE
              WHEN $6::boolean IS NULL THEN archived_at
              WHEN $6 THEN COALESCE(archived_at, now())
              ELSE NULL
            END
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, title ?? null, dueDateGiven, dueDate ?? null, completed ?? null, archived ?? null],
  );

  if (rows.length === 0) throw notFound("No such task");
  return rows[0];
}

/**
 * What the month did to the task list.
 *
 * Instants are compared in the app's own time zone, so "completed in January"
 * means the calendar month the user lived, not the server's UTC one. The counts
 * are cast to int because count() is bigint, which node-postgres returns as a
 * string.
 */
export async function countTasksBetween(from, to) {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (
         WHERE completed_at IS NOT NULL
           AND (completed_at AT TIME ZONE $1)::date BETWEEN $2 AND $3
       )::int AS completed,
       count(*) FILTER (
         WHERE (created_at AT TIME ZONE $1)::date BETWEEN $2 AND $3
       )::int AS created
     FROM tasks
     WHERE archived_at IS NULL`,
    [config.timezone, from, to],
  );
  return rows[0];
}
