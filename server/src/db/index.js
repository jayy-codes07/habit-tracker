import { AsyncLocalStorage } from "node:async_hooks";

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

/**
 * The transaction in progress on the current async call path, if any.
 *
 * Without this, `query()` always goes to the pool, so a statement issued inside
 * withTransaction by anything that did not receive the client would run on a
 * different connection — outside the transaction, invisible to it, and
 * unaffected by its rollback.
 */
const transactionContext = new AsyncLocalStorage();

function currentClient() {
  return transactionContext.getStore()?.client ?? null;
}

/**
 * Runs on the ambient transaction client when there is one, and on the pool
 * otherwise, so callers do not have to thread a client through every layer.
 */
export function query(text, params) {
  const client = currentClient();
  return client ? client.query(text, params) : pool.query(text, params);
}

/**
 * Runs fn inside a transaction, releasing the client whatever happens.
 *
 * Reentrant by design: a nested call joins the transaction already in progress,
 * through the ambient client above, instead of taking a second connection from
 * the pool. A nested call on its own connection would block on the locks the
 * outer one holds, and with max: 10 a handful of those deadlocks the pool.
 *
 * The callback still receives the client, so existing `fn(client)` code is
 * unchanged; plain `query()` calls inside it join the transaction too.
 *
 * There is one sharp edge, and it is Postgres', not ours. Nesting is flattened —
 * there are no savepoints — so an inner statement that fails aborts the whole
 * transaction. Catching that error does NOT make the outer transaction usable
 * again: every later statement on it fails with "current transaction is
 * aborted" until it unwinds. So a caller cannot treat an inner withTransaction
 * as something it can attempt and recover from. If a genuine need for partial
 * rollback appears, that is a SAVEPOINT, deliberately not implemented until
 * something actually requires it.
 */
export async function withTransaction(fn) {
  const existing = currentClient();
  if (existing) return fn(existing);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await transactionContext.run({ client }, () => fn(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Installs `client` as the ambient transaction client for the duration of `fn`,
 * without issuing BEGIN or COMMIT itself.
 *
 * This exists for the test harness, which opens one transaction per test and
 * rolls it back afterwards. Application code should use withTransaction.
 */
export function runWithClient(client, fn) {
  return transactionContext.run({ client }, fn);
}

export async function checkConnection() {
  const { rows } = await pool.query("SELECT version() AS version");
  return rows[0].version;
}
