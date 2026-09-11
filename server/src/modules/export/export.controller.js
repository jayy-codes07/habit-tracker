/**
 * The whole database, as one JSON file.
 *
 * This exists to make the app trustworthy rather than clever: months of habit
 * history are only worth recording if they can be taken back out again. Raw
 * rows, no computed streaks and no reshaping — anything derived can be
 * recomputed, but a lost row is lost.
 *
 * Archived habits and tasks are included deliberately. An export that quietly
 * dropped them would not be a backup.
 *
 * No service file: five selects and no logic, following the health module's
 * precedent that a module is only as many files as it needs.
 */
import { query } from "../../db/index.js";
import { today } from "../../lib/dates.js";

const TABLES = {
  habits: `SELECT id, name, color_token, sort_order, start_date, target_value, unit,
                  created_at, updated_at, archived_at
             FROM habits ORDER BY id`,
  habit_schedules: `SELECT id, habit_id, effective_from, schedule_kind, schedule_days,
                           weekly_target, created_at, updated_at
                      FROM habit_schedules ORDER BY habit_id, effective_from`,
  habit_logs: `SELECT id, habit_id, date, status, value, note, updated_at
                 FROM habit_logs ORDER BY habit_id, date`,
  tasks: `SELECT id, title, due_date, completed, completed_at, created_at, updated_at, archived_at
            FROM tasks ORDER BY id`,
  journal: `SELECT id, date, kind, entry, updated_at FROM journal ORDER BY kind, date`,
};

export async function exportAll(_req, res) {
  const entries = await Promise.all(
    Object.entries(TABLES).map(async ([table, sql]) => [table, (await query(sql)).rows]),
  );

  // The instant, for the record; the calendar day, for the human reading the
  // filename. Slicing the instant would name the file yesterday for anyone far
  // enough east of UTC.
  const exportedAt = new Date().toISOString();

  res.set("Content-Disposition", `attachment; filename="habit-tracker-${today()}.json"`);

  res.json({
    // Bumped only if the shape ever changes, so an old file stays readable.
    version: 1,
    exported_at: exportedAt,
    ...Object.fromEntries(entries),
  });
}
