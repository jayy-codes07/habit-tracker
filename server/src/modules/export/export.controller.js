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
 * The file is also the restore format. Reading it back is the other half of
 * being a backup rather than a souvenir — see export.service.js, which owns the
 * validation and the one transaction that replaces everything.
 */
import { query } from "../../db/index.js";
import { today } from "../../lib/dates.js";
import { badRequest } from "../../lib/errors.js";
import * as backup from "./export.service.js";

// numeric is cast to float8 for the same reason the rest of the API casts it:
// node-postgres hands numeric back as a string, and a backup whose amounts are
// quoted in one file and bare in the next is a backup someone has to write a
// parser for. Raw rows means no derived values and no reshaping, not no types.
const TABLES = {
  habits: `SELECT id, name, color_token, sort_order, start_date, unit, reminder_at,
                  created_at, updated_at, archived_at
             FROM habits ORDER BY id`,
  habit_schedules: `SELECT id, habit_id, effective_from, schedule_kind, schedule_days,
                           weekly_target, target_value::float8 AS target_value,
                           created_at, updated_at
                      FROM habit_schedules ORDER BY habit_id, effective_from`,
  habit_logs: `SELECT id, habit_id, date, status, value::float8 AS value, note, updated_at
                 FROM habit_logs ORDER BY habit_id, date`,
  tasks: `SELECT id, title, due_date, completed, completed_at, reminder_at,
                 created_at, updated_at, archived_at
            FROM tasks ORDER BY id`,
  journal: `SELECT id, date, kind, entry, updated_at FROM journal ORDER BY kind, date`,
  /*
   * Complete, screenshots included — the reference to one, which is now the
   * whole of what the database holds. The bytes are in Cloudinary and stay
   * there; a restored row points at the same asset it always did.
   *
   * This is why the column moved out of Postgres. res.json() builds the whole
   * document in memory before it writes a byte, so a few hundred embedded
   * problem statements was a backup that exhausted the heap.
   */
  /*
   * The one row of preferences. It is a handful of booleans and times, but it
   * is also the only thing in the database that would otherwise have to be set
   * up again by hand after a restore.
   */
  app_settings: `SELECT id, notifications_enabled, habit_reminders, task_reminders,
                        leetcode_reminder_at, quiet_start, quiet_end, updated_at
                   FROM app_settings ORDER BY id`,
  leetcode_problems: `SELECT id, number, title, difficulty, topics, url, solved_on,
                             ai_assisted, reviewed_on, approach, solution,
                             screenshot_public_id, screenshot_format,
                             screenshot_width, screenshot_height, screenshot_bytes,
                             created_at, updated_at, archived_at
                        FROM leetcode_problems ORDER BY id`,
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
    /*
     * Bumped only if the shape ever changes, so an old file stays readable.
     *
     * 2: the per-occasion target moved from habits.target_value to
     * habit_schedules.target_value, because a habit's target has a history
     * exactly as its schedule does. A version 1 file is still complete — its
     * habits.target_value belongs to every non-paused version of that habit,
     * which is what the column meant when one value covered all of time.
     *
     * 3: leetcode_problems joined the document. Purely additive — a version 2
     * file is still complete for everything it describes — but it is the first
     * version whose completeness has a caveat, and a consumer has to be able to
     * tell which files can be missing image bytes. See the note beside the
     * query above.
     *
     * 5: reminders. habits and tasks carry reminder_at, and app_settings — the
     * single row of preferences — is a table in the document. reminder_deliveries
     * is deliberately NOT here: it is a week of dedupe state saying what was
     * already shown on screen, not a record of anything that happened to you,
     * and restoring it would only suppress today's reminders once.
     *
     * 4: the screenshot moved to Cloudinary, so leetcode_problems now carries
     * screenshot_public_id and its dimensions instead of screenshot_type. A
     * version 3 file describes images that were in the database itself and are
     * only in a pg_dump; a version 4 file names the asset each row points at.
     */
    version: 5,
    exported_at: exportedAt,
    ...Object.fromEntries(entries),
  });
}

/**
 * What is in this file, and would it load — without touching the database.
 *
 * It exists so the confirmation the person gives is a confirmation of something
 * real. Counting the rows in the browser would be easy and would also be a
 * different program's opinion: this runs the exact validation the restore runs,
 * so "7 habits, 412 logs" is a promise the next call keeps.
 */
export async function inspectBackup(req, res) {
  const { parsed: _parsed, ...summary } = backup.inspect(req.body);
  res.json(summary);
}

/**
 * Replace everything with the file. All of it, or none of it.
 *
 * Integrity errors get turned into a 400 here rather than escaping as a 500:
 * a file that Postgres refuses is a bad backup, which is the caller's problem
 * and not a bug in this server. Anything else still goes to the error handler
 * and is still logged.
 */
export async function importBackup(req, res) {
  try {
    res.json(await backup.restore(req.body));
  } catch (error) {
    // 22xxx data exception, 23xxx integrity violation — a row this database
    // will not accept. The message is Postgres' own, which names the constraint
    // and is the only useful thing anyone could be told about it.
    if (/^2[23]/.test(error?.code ?? ""))
      throw badRequest(`That backup was rejected: ${error.message}`);
    throw error;
  }
}
