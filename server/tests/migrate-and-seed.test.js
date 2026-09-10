/**
 * Migration idempotency and seed determinism.
 *
 * These two properties were previously only ever checked by hand, which meant
 * nothing would notice them breaking. They matter beyond tidiness: the migration
 * runner is what every deploy calls, and the seed is the fixture the Step 4
 * streak and consistency tests will assert against — a seed that stopped being
 * deterministic would make those tests flap for reasons that looked unrelated
 * to the change that caused it.
 *
 * Both run against their own scratch database, created and dropped here. They
 * commit, so they cannot share the transactional test database that every other
 * file rolls back — and Node runs test files concurrently, so "just truncate"
 * would race. The scratch database sidesteps both.
 *
 * The real CLI entry points are invoked as child processes rather than imported,
 * because src/db builds its pool from DATABASE_URL at import time and this needs
 * a different database. It also means these tests exercise exactly what
 * `npm run db:migrate` and `npm run db:seed` do.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import pg from "pg";

import { databaseNameOf, resolveTestDatabaseUrl } from "./helpers/database-url.js";

const execFileAsync = promisify(execFile);
const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const testDatabaseUrl = resolveTestDatabaseUrl();
const SCRATCH_NAME = `${databaseNameOf(testDatabaseUrl)}_scratch`;
const quotedScratch = `"${SCRATCH_NAME.replace(/"/g, '""')}"`;

function urlForDatabase(name) {
  const url = new URL(testDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const scratchUrl = urlForDatabase(SCRATCH_NAME);

/** Runs one statement on the maintenance database, which always exists. */
async function onMaintenanceDatabase(sql) {
  const client = new pg.Client({ connectionString: urlForDatabase("postgres") });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

async function onScratch(sql) {
  const client = new pg.Client({ connectionString: scratchUrl });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Runs a project script against the scratch database. */
function runScript(scriptPath) {
  return execFileAsync(process.execPath, [scriptPath], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: scratchUrl },
  });
}

const migrateScript = "src/db/migrate.js";
const seedScript = "src/db/seeds/dev-seed.js";

/**
 * A stable fingerprint of everything the seed is supposed to produce.
 *
 * Natural keys only, and created_at/updated_at are deliberately excluded: those
 * come from now(), so including them would make the digest differ on every run
 * and prove nothing. Row counts alone would miss reordering, a changed status,
 * or a schedule landing on the wrong date, which is exactly what could regress.
 */
const DIGEST_SQL = `
  WITH seeded AS (
    SELECT format('habit|%s|%s|%s|%s', h.name, h.color_token, h.sort_order, h.start_date) AS row
      FROM habits h
    UNION ALL
    SELECT format('schedule|%s|%s|%s|%s|%s', h.name, s.effective_from, s.schedule_kind,
                  coalesce(s.schedule_days::text, '-'), coalesce(s.weekly_target::text, '-'))
      FROM habit_schedules s JOIN habits h ON h.id = s.habit_id
    UNION ALL
    SELECT format('log|%s|%s|%s|%s', h.name, l.date, l.status, coalesce(l.note, '-'))
      FROM habit_logs l JOIN habits h ON h.id = l.habit_id
    UNION ALL
    SELECT format('task|%s|%s|%s|%s', t.title, coalesce(t.due_date::text, '-'),
                  t.completed, coalesce(t.archived_at::text, '-'))
      FROM tasks t
    UNION ALL
    SELECT format('journal|%s|%s|%s', j.date, j.kind, j.entry)
      FROM journal j
  )
  SELECT md5(string_agg(row, E'\\n' ORDER BY row)) AS digest, count(*)::int AS rows FROM seeded
`;

async function seededDigest() {
  const { rows } = await onScratch(DIGEST_SQL);
  return rows[0];
}

before(async () => {
  // WITH (FORCE) so a connection left by an earlier failed run cannot block us.
  await onMaintenanceDatabase(`DROP DATABASE IF EXISTS ${quotedScratch} WITH (FORCE)`);
  await onMaintenanceDatabase(`CREATE DATABASE ${quotedScratch}`);
});

after(async () => {
  await onMaintenanceDatabase(`DROP DATABASE IF EXISTS ${quotedScratch} WITH (FORCE)`);
});

describe("migration runner", () => {
  it("applies the schema to an empty database", async () => {
    const { stdout } = await runScript(migrateScript);
    assert.match(stdout, /applied 001_init\.sql/);

    const { rows } = await onScratch("SELECT filename FROM schema_migrations ORDER BY filename");
    assert.deepEqual(
      rows.map((row) => row.filename),
      ["001_init.sql"],
    );
  });

  it("is a no-op when re-run", async () => {
    const { stdout } = await runScript(migrateScript);
    assert.match(stdout, /up to date/);
    // Not /applied/ — the no-op line itself says "already applied". What must
    // be absent is the line reporting a file being run.
    assert.doesNotMatch(stdout, /applied 001_init\.sql/);
  });

  it("records each migration exactly once however often it runs", async () => {
    await runScript(migrateScript);
    await runScript(migrateScript);

    const { rows } = await onScratch("SELECT count(*)::int AS count FROM schema_migrations");
    assert.equal(rows[0].count, 1);
  });

  it("leaves the schema intact after repeated runs", async () => {
    const { rows } = await onScratch(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name
    `);
    assert.deepEqual(
      rows.map((row) => row.table_name),
      ["habit_logs", "habit_schedules", "habits", "journal", "schema_migrations", "tasks"],
    );
  });
});

describe("seed determinism", () => {
  it("produces the same data every time it runs", async () => {
    await runScript(seedScript);
    const first = await seededDigest();

    await runScript(seedScript);
    const second = await seededDigest();

    assert.ok(first.rows > 300, `seed produced only ${first.rows} rows`);
    assert.equal(second.rows, first.rows, "re-seeding changed the row count");
    assert.equal(second.digest, first.digest, "re-seeding produced different data");
  });

  it("seeds the cases the streak tests will rely on", async () => {
    // Guards the fixture's contract, not its exact numbers: if a future edit
    // drops the paused span or the schedule change, the Step 4 tests built on
    // them would quietly stop testing anything.
    const { rows } = await onScratch(`
      SELECT
        (SELECT count(*)::int FROM habit_schedules WHERE schedule_kind = 'paused')  AS paused,
        (SELECT count(*)::int FROM habit_logs      WHERE status = 'skipped')        AS skipped,
        (SELECT count(*)::int FROM habit_logs      WHERE status = 'missed')         AS missed,
        (SELECT count(*)::int FROM habit_schedules WHERE schedule_kind = 'weekly')  AS weekly,
        (SELECT count(*)::int FROM habits          WHERE archived_at IS NOT NULL)   AS archived,
        (SELECT count(*)::int FROM habits h
          WHERE (SELECT count(*) FROM habit_schedules s WHERE s.habit_id = h.id) > 1) AS versioned
    `);
    const seeded = rows[0];

    assert.ok(seeded.paused > 0, "no paused schedule in the seed");
    assert.ok(seeded.skipped > 0, "no skipped logs in the seed");
    assert.ok(seeded.missed > 0, "no missed logs in the seed");
    assert.ok(seeded.weekly > 0, "no weekly-target habit in the seed");
    assert.ok(seeded.archived > 0, "no archived habit in the seed");
    assert.ok(seeded.versioned >= 2, "fewer than two habits have a schedule history");
  });

  it("never scores a day against a schedule that was not in force", async () => {
    // The invariant the versioned schedule exists for: every logged day must
    // fall on a day its own schedule version actually scheduled.
    const { rows } = await onScratch(`
      SELECT count(*)::int AS wrong
        FROM habit_logs l
        JOIN habits h ON h.id = l.habit_id
        JOIN LATERAL (
          SELECT s.* FROM habit_schedules s
           WHERE s.habit_id = l.habit_id AND s.effective_from <= l.date
           ORDER BY s.effective_from DESC LIMIT 1
        ) sched ON true
       WHERE l.date >= h.start_date
         AND (
           sched.schedule_kind = 'paused'
           OR (sched.schedule_kind = 'fixed'
               AND NOT (EXTRACT(ISODOW FROM l.date)::smallint = ANY (sched.schedule_days)))
         )
    `);
    assert.equal(rows[0].wrong, 0, "the seed logged days that its schedule never scheduled");
  });
});
