/**
 * Creates the test database if it is missing and brings it up to date.
 *
 *   npm run test:db
 *
 * Runs automatically before `npm test` (see the pretest script), so a fresh
 * checkout needs no manual step and a new migration is never missed.
 */
import pg from "pg";

import { databaseNameOf, resolveTestDatabaseUrl } from "./database-url.js";

const testDatabaseUrl = resolveTestDatabaseUrl();
const name = databaseNameOf(testDatabaseUrl);

/** CREATE DATABASE takes an identifier, which cannot be a bound parameter. */
const quoted = `"${name.replace(/"/g, '""')}"`;

async function ensureDatabase() {
  // 'postgres' always exists, and CREATE DATABASE cannot run from inside the
  // database being created.
  const maintenance = new URL(testDatabaseUrl);
  maintenance.pathname = "/postgres";

  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (rowCount) {
      console.log(`[test:db] ${name} already exists`);
      return;
    }
    await client.query(`CREATE DATABASE ${quoted}`);
    console.log(`[test:db] created ${name}`);
  } finally {
    await client.end();
  }
}

async function main() {
  await ensureDatabase();

  // Imported only now, and dynamically: src/db builds its pool from config at
  // import time, so DATABASE_URL has to point at the test database first.
  process.env.DATABASE_URL = testDatabaseUrl;
  const { migrate } = await import("../../src/db/migrate.js");
  const { pool } = await import("../../src/db/index.js");

  try {
    await migrate({ log: (message) => console.log(message.replace("[migrate]", "[test:db]")) });
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(`[test:db] ${error.message}`);
  process.exitCode = 1;
}
