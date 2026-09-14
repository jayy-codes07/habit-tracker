import { defineConfig } from "@playwright/test";

/**
 * The regression suite for bugs that only exist in a browser.
 *
 * Everything the server can be held to is held to it by `npm test` in server/,
 * which is faster, needs no browser and runs in a rolled-back transaction. This
 * exists for the handful of failures that live above the API and that no
 * server test can see: a query cache that strands its observer, a tap that
 * deletes a note, a grid that overflows the page.
 *
 * It runs against the development stack and the development database, because
 * that is what the SPA talks to:
 *
 *   docker compose up -d          the API on :3000 and Postgres
 *   cd web && npm run test:e2e    starts Vite itself
 *
 * One worker, in order: there is one database and one user, and these tests
 * write to it. Each cleans up the fixtures it made.
 */
const BASE_URL = "http://localhost:5173";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  // A failing assertion here means a real regression, so let it fail loudly
  // rather than passing on the second go.
  retries: 0,
  reporter: "list",
  use: {
    // Vite's default port, which webServer below starts it on. There is no env
    // override: this project runs in one place, and a second knob to keep
    // working is worse than the one line to edit if that ever changes.
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    // A dev server is usually already up while you are working on this.
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
