import pg from "pg";

import { config } from "../config/index.js";

// DATE (oid 1082) must stay a 'YYYY-MM-DD' string. Letting node-postgres parse it
// into a JS Date reintroduces timezone shifts on a column that has no time at all.
pg.types.setTypeParser(1082, (value) => value);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// A pool error (e.g. the database restarting) must not take the process down.
pool.on("error", (error) => {
  console.error("[db] idle client error:", error.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

/** Runs fn inside a transaction, releasing the client whatever happens. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function checkConnection() {
  const { rows } = await pool.query("SELECT version() AS version");
  return rows[0].version;
}
