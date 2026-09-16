/**
 * Restore: the other half of the backup, and the only write in this module.
 *
 * The export is raw rows, so the restore is raw rows too — no reshaping, no
 * derivation, and ids preserved exactly, because ids are what hold a schedule
 * version to its habit and a log to its day. Every timestamp in the file is the
 * one that goes back into the column, so a restored record reads as the record
 * that was lived rather than as a record made today.
 *
 * Three rules do all the work here:
 *
 *  - VALIDATE EVERYTHING BEFORE WRITING ANYTHING. A backup is the thing you
 *    reach for when something has already gone wrong; an import that failed
 *    halfway would be the second disaster in one afternoon.
 *  - ONE TRANSACTION. The delete and every insert are the same transaction, so a
 *    row Postgres refuses takes the whole restore down with it and leaves the
 *    database exactly as it was. This is one of the very few write paths here
 *    that genuinely needs withTransaction (see CLAUDE.md).
 *  - REPLACE, NEVER MERGE. There is one user and one database; a merge would
 *    mean inventing an identity for every row and a rule for every conflict,
 *    and getting either wrong silently corrupts years of history.
 */
import { z } from "zod";

import { query, withTransaction } from "../../db/index.js";
import { badRequest } from "../../lib/errors.js";
import { isoDate } from "../../lib/schemas.js";

/**
 * The only version this restores. The export has been through five shapes and
 * only the current one has ever left this machine; accepting the older four
 * would mean four migration paths maintained for files that do not exist.
 *
 * An older or newer file is refused by number rather than guessed at — a backup
 * half-understood is worse than one honestly rejected.
 */
export const BACKUP_VERSION = 5;

const id = z.string().regex(/^\d+$/, "must be a numeric id");
/** A timestamptz, as res.json() renders one. Not parsed — Postgres does that. */
const instant = z.string().min(1);
/** Postgres hands `time` back as HH:MM:SS; a hand-written HH:MM is fine too. */
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "must be a time");

/*
 * Every key the export writes is required, nullable exactly where the column
 * is. Presence is the check that matters: a file truncated by a failed download
 * is the realistic corruption, and a missing key would otherwise arrive as NULL
 * and be refused by a constraint far from the thing that was actually wrong.
 *
 * Shape only. The domain rules — a fixed version carries days, a completed task
 * carries a completion time, a screenshot is all five columns or none — stay in
 * the CHECK constraints that already enforce them for every other writer, and
 * they run inside the same transaction.
 */
const habit = z.object({
  id,
  name: z.string(),
  color_token: z.string(),
  sort_order: z.number().int(),
  start_date: isoDate,
  unit: z.string().nullable(),
  reminder_at: clock.nullable(),
  created_at: instant,
  updated_at: instant,
  archived_at: instant.nullable(),
});

const habitSchedule = z.object({
  id,
  habit_id: id,
  effective_from: isoDate,
  schedule_kind: z.string(),
  schedule_days: z.array(z.number().int()).nullable(),
  weekly_target: z.number().int().nullable(),
  target_value: z.number().nullable(),
  created_at: instant,
  updated_at: instant,
});

const habitLog = z.object({
  id,
  habit_id: id,
  date: isoDate,
  status: z.string(),
  value: z.number().nullable(),
  note: z.string().nullable(),
  updated_at: instant,
});

const task = z.object({
  id,
  title: z.string(),
  due_date: isoDate.nullable(),
  completed: z.boolean(),
  completed_at: instant.nullable(),
  reminder_at: clock.nullable(),
  created_at: instant,
  updated_at: instant,
  archived_at: instant.nullable(),
});

const journal = z.object({
  id,
  date: isoDate,
  kind: z.string(),
  entry: z.string(),
  updated_at: instant,
});

/*
 * The Cloudinary reference, and nothing of the image itself. The bytes are not
 * in the file and are not meant to be — see the note on the controller — so a
 * restore reinstates the pointer and depends on the asset still being there.
 */
const leetcodeProblem = z.object({
  id,
  number: z.number().int().nullable(),
  title: z.string(),
  difficulty: z.string(),
  topics: z.array(z.string()),
  url: z.string().nullable(),
  solved_on: isoDate,
  ai_assisted: z.boolean(),
  reviewed_on: isoDate.nullable(),
  approach: z.string().nullable(),
  solution: z.string().nullable(),
  screenshot_public_id: z.string().nullable(),
  screenshot_format: z.string().nullable(),
  screenshot_width: z.number().int().nullable(),
  screenshot_height: z.number().int().nullable(),
  screenshot_bytes: z.number().int().nullable(),
  created_at: instant,
  updated_at: instant,
  archived_at: instant.nullable(),
});

const appSettings = z.object({
  id: z.number().int(),
  notifications_enabled: z.boolean(),
  habit_reminders: z.boolean(),
  task_reminders: z.boolean(),
  leetcode_reminder_at: clock.nullable(),
  quiet_start: clock.nullable(),
  quiet_end: clock.nullable(),
  updated_at: instant,
});

/**
 * The document. Unknown top-level keys are allowed and nothing else is: a file
 * from a later version may carry a table this build has never heard of, and
 * refusing the whole backup over a key we would ignore anyway helps nobody. The
 * version check below is what guards compatibility.
 */
const backup = z.looseObject({
  version: z.literal(BACKUP_VERSION),
  exported_at: instant,
  habits: z.array(habit),
  habit_schedules: z.array(habitSchedule),
  habit_logs: z.array(habitLog),
  tasks: z.array(task),
  journal: z.array(journal),
  leetcode_problems: z.array(leetcodeProblem),
  app_settings: z.array(appSettings),
});

/**
 * Parsed, checked and counted — the summary the person confirms against.
 *
 * Separated from the write so the same validation runs twice: once to answer
 * "what is in this file and will it load", and once inside the transaction that
 * actually loads it. Nothing is trusted from the first call to the second.
 */
export function inspect(document) {
  if (document === null || typeof document !== "object" || Array.isArray(document))
    throw badRequest("That file is not a backup.");

  const { version } = document;
  if (version !== BACKUP_VERSION)
    throw badRequest(
      typeof version === "number"
        ? `That backup is version ${version}; this app restores version ${BACKUP_VERSION}.`
        : "That file is not a backup: it carries no version.",
    );

  const parsed = backup.parse(document);

  return {
    version: parsed.version,
    exported_at: parsed.exported_at,
    counts: {
      habits: parsed.habits.length,
      habit_schedules: parsed.habit_schedules.length,
      habit_logs: parsed.habit_logs.length,
      tasks: parsed.tasks.length,
      journal: parsed.journal.length,
      leetcode_problems: parsed.leetcode_problems.length,
      app_settings: parsed.app_settings.length,
    },
    // Called out on its own because it is the one thing in the file that is a
    // reference rather than a value: this many restored problems will show an
    // image only while the Cloudinary account still holds the asset.
    screenshots: parsed.leetcode_problems.filter((row) => row.screenshot_public_id !== null).length,
    parsed,
  };
}

/*
 * Parent before child, so a schedule never lands before its habit. The truncate
 * takes them all at once; habit_schedules and habit_logs would go with their
 * habit by cascade anyway and are named only so the insert loop can reach them.
 */
const TABLES = ["habits", "habit_schedules", "habit_logs", "tasks", "journal", "leetcode_problems"];

/**
 * Replaces everything with the file's contents, or changes nothing at all.
 *
 * json_populate_recordset maps the JSON straight onto the table's own row type,
 * which is why there is no column list and no per-table insert here: the export
 * writes exactly the columns each table has, and a key the table does not have
 * is ignored rather than becoming a syntax error. OVERRIDING SYSTEM VALUE is
 * what lets the file's ids through an identity column.
 */
export async function restore(document) {
  const { parsed, counts, exported_at: exportedAt, screenshots } = inspect(document);

  await withTransaction(async () => {
    /*
     * reminder_deliveries goes too, and it is not optional. It is keyed by
     * (thing, day), so an id coming out of the file can collide with a delivery
     * recorded against a row that no longer exists — which would silently
     * swallow the restored habit's reminder for the rest of today.
     *
     * push_subscriptions deliberately survives: it is what this browser is, not
     * what the record is, and a restore that signed every device out of its own
     * notifications would look exactly like a restore that broke them.
     */
    await query(
      `TRUNCATE ${TABLES.join(", ")}, app_settings, reminder_deliveries RESTART IDENTITY CASCADE`,
    );

    for (const table of TABLES) {
      await query(
        `INSERT INTO ${table} OVERRIDING SYSTEM VALUE
         SELECT * FROM json_populate_recordset(NULL::${table}, $1::json)`,
        [JSON.stringify(parsed[table])],
      );

      // The identity sequence restarted at 1 with the truncate, so without this
      // the next habit created after a restore collides with the first one in
      // the file. `false` means "this value has not been handed out yet".
      await query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'),
                       COALESCE((SELECT max(id) FROM ${table}), 0) + 1, false)`,
        [table],
      );
    }

    /*
     * The settings row is a singleton with a fixed id and no identity, so it
     * takes neither the OVERRIDING clause nor a sequence. A file with no
     * settings row still has to leave one behind — every reminder read assumes
     * it exists — so the column defaults stand in.
     */
    if (parsed.app_settings.length > 0) {
      await query(
        `INSERT INTO app_settings
         SELECT * FROM json_populate_recordset(NULL::app_settings, $1::json)`,
        [JSON.stringify(parsed.app_settings)],
      );
    } else {
      await query("INSERT INTO app_settings (id) VALUES (1)");
    }
  });

  return { restored: counts, exported_at: exportedAt, screenshots };
}
