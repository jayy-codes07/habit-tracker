import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pool } from "./index.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

// Any integer works; it just has to be the same in every process that migrates.
const ADVISORY_LOCK_KEY = 8_274_119_057_432_100n;

async function listMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  // Zero-padded numeric prefixes mean plain lexicographic order is correct.
  return entries.filter((name) => name.endsWith(".sql")).sort();
}

/**
 * The runner owns this table rather than depending on a migration having created
 * it — the applied list has to be readable before the first migration runs.
 * 001_init.sql declares it too (IF NOT EXISTS), so the schema file stays complete.
 */
async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function migrate({ log = console.log } = {}) {
  const client = await pool.connect();
  const applied = [];

  try {
    // Serialize concurrent runners (two API instances booting at once).
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    await ensureMigrationsTable(client);

    const { rows } = await client.query("SELECT filename FROM schema_migrations");
    const done = new Set(rows.map((row) => row.filename));
    const files = await listMigrationFiles();
    const pending = files.filter((file) => !done.has(file));

    if (pending.length === 0) {
      log(`[migrate] up to date — ${files.length} migration(s) already applied`);
      return applied;
    }

    for (const filename of pending) {
      const sql = await readFile(join(MIGRATIONS_DIR, filename), "utf8");
      const startedAt = Date.now();

      // The migration and its bookkeeping row commit together. If the SQL fails,
      // the rollback takes the record with it, so a failed migration is never
      // recorded and the next run retries it from a clean slate.
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`Migration ${filename} failed: ${error.message}`, { cause: error });
      }

      applied.push(filename);
      log(`[migrate] applied ${filename} (${Date.now() - startedAt}ms)`);
    }

    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

// Run directly: node src/migrate.js
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("migrate.js")) {
  try {
    await migrate();
  } catch (error) {
    console.error(`[migrate] ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
