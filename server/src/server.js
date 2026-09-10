import { createApp } from "./app.js";
import { config } from "./config/index.js";
import { pool } from "./db/index.js";

const app = createApp();

const server = app.listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port} (${config.env})`);
});

// Clean shutdown: stop accepting connections, then drain the pool. Without this,
// a restart can leave connections hanging until Postgres times them out.
async function shutdown(signal) {
  console.log(`[api] ${signal} received, shutting down`);
  server.close(async () => {
    await pool.end().catch((error) => console.error("[db] pool close failed:", error.message));
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => shutdown(signal));
}
