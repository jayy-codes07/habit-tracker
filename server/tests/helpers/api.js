/**
 * An authenticated API client over the rollback harness.
 *
 * Everything past the auth boundary needs a session cookie, and every feature
 * test would otherwise repeat the same login dance. This wraps
 * withRollbackServer — never withRollback plus a hand-rolled listen(), which
 * silently commits — and hands back a request helper that carries the cookie
 * and JSON-encodes bodies.
 */
import { createApp } from "../../src/app.js";
import { config } from "../../src/config/index.js";
import { hashPassword, SESSION_COOKIE } from "../../src/modules/auth/auth.service.js";
import { withRollbackServer } from "./db.js";

const PASSWORD = "correct-horse-battery-staple";
const TEST_SECRET = "test-secret-that-is-comfortably-long-enough-for-hs256";

let ready = null;

/**
 * createApp() calls assertAuthConfig(), so the auth settings have to be valid
 * before the first app is built. config snapshots the environment at import, so
 * the live object is what gets configured — the same thing the running server
 * reads. Hashing is deliberately slow, so it happens once per test process.
 */
function configureAuth() {
  ready ??= (async () => {
    config.env = "test";
    config.auth.passwordHash = await hashPassword(PASSWORD);
    config.auth.secret = TEST_SECRET;
    config.auth.ttlDays = 30;
  })();
  return ready;
}

/**
 * Runs `run({ api, request, client })` against a live server inside a
 * transaction that is always rolled back.
 *
 *   api(path, { method, body })  authenticated, JSON in and out
 *   request(path, options)       the raw unauthenticated fetch
 */
export async function withApi(run) {
  await configureAuth();

  return withRollbackServer(createApp, async ({ request, client }) => {
    const response = await request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });

    const setCookie = response.headers.getSetCookie?.() ?? [];
    const cookie = setCookie.find((value) => value.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0];
    if (!cookie) throw new Error("test login did not return a session cookie");

    const api = (path, { body, headers, ...options } = {}) =>
      request(path, {
        ...options,
        headers: {
          cookie,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    return run({ api, request, client });
  });
}

/** Response body plus status, for the common "assert both" case. */
export async function json(response) {
  return { status: response.status, body: await response.json() };
}
