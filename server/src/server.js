import { createApp } from "./app.js";
import { config } from "./config/index.js";
import { pool } from "./db/index.js";
import { startReminderScheduler } from "./modules/reminders/scheduler.js";

const app = createApp();

/*
 * Started here rather than inside createApp(): this is the one process that
 * should own a timer. An app built by a test must not start one that outlives
 * the test and writes to the database it is rolling back.
 */
const stopScheduler = startReminderScheduler();

const server = app.listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port} (${config.env})`);
});

// Clean shutdown: stop accepting connections, then drain the pool. Without this,
// a restart can leave connections hanging until Postgres times them out.
async function shutdown(signal) {
  console.log(`[api] ${signal} received, shutting down`);
  stopScheduler();
  server.close(async () => {
    await pool.end().catch((error) => console.error("[db] pool close failed:", error.message));
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => shutdown(signal));
}
