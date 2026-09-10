/**
 * Authentication tests.
 *
 * Each test builds its own app instance, so the login rate limiter starts empty
 * and one test's failed attempts cannot bleed into another's.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const PASSWORD = "correct-horse-battery-staple";
const WRONG_PASSWORD = "incorrect-horse-battery-staple";

const TEST_SECRET = "test-secret-that-is-comfortably-long-enough-for-hs256";

let createApp;
let auth;
let config;
let jwt;
let pool;

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL ??= "postgres://habit:habit_dev_password@localhost:5432/habit_tracker";

  auth = await import("../src/modules/auth/auth.service.js");
  ({ config } = await import("../src/config/index.js"));

  // config snapshots the environment when it is first imported, and generating a
  // hash requires auth.js — which imports config. So configure the live object
  // rather than the environment; this is also what the running server reads.
  config.env = "test";
  config.auth.passwordHash = await auth.hashPassword(PASSWORD);
  config.auth.secret = TEST_SECRET;
  config.auth.ttlDays = 30;

  ({ createApp } = await import("../src/app.js"));
  ({ pool } = await import("../src/db/index.js"));
  jwt = (await import("jsonwebtoken")).default;
});

after(async () => {
  await pool?.end?.().catch(() => {});
});

/** Starts an app on an ephemeral port and yields a fetch bound to its base URL. */
async function withServer(run) {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    return await run((path, options) => fetch(`${base}${path}`, options));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const sessionCookie = (response) =>
  (response.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("ht_session="));

const login = (call, password) =>
  call("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });

describe("login", () => {
  it("accepts the correct password and sets an httpOnly session cookie", async () => {
    await withServer(async (call) => {
      const response = await login(call, PASSWORD);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { authenticated: true });

      const cookie = sessionCookie(response);
      assert.ok(cookie, "expected a ht_session cookie");
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
      assert.match(cookie, /Path=\//i);
      // NODE_ENV is "test" here, so Secure is correctly absent; it is asserted
      // for production separately below.
      assert.doesNotMatch(cookie, /Secure/i);
      // The cookie must carry a token, not the password or the hash.
      assert.doesNotMatch(cookie, new RegExp(PASSWORD));
      assert.doesNotMatch(cookie, /scrypt/);
    });
  });

  it("rejects the wrong password with 401 and no cookie", async () => {
    await withServer(async (call) => {
      const response = await login(call, WRONG_PASSWORD);
      assert.equal(response.status, 401);
      assert.equal(sessionCookie(response), undefined);

      const body = await response.json();
      assert.equal(body.error, "Invalid password");
      // The response must not hint at what was wrong beyond "invalid".
      assert.equal(Object.keys(body).length, 1);
    });
  });

  it("rejects a missing or non-string password the same way", async () => {
    await withServer(async (call) => {
      for (const body of [
        "{}",
        JSON.stringify({ password: 12345 }),
        JSON.stringify({ password: "" }),
      ]) {
        const response = await call("/api/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        assert.equal(response.status, 401, `body ${body} should be 401`);
      }
    });
  });

  it("rate-limits repeated failures with a 429 and a Retry-After", async () => {
    await withServer(async (call) => {
      const statuses = [];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        statuses.push((await login(call, WRONG_PASSWORD)).status);
      }

      assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
      assert.deepEqual(statuses.slice(5), [429, 429]);

      const limited = await login(call, WRONG_PASSWORD);
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);

      const body = await limited.json();
      assert.equal(body.error, "Too many login attempts");
      assert.ok(body.retryAfterSeconds > 0);

      // Even the correct password is refused once the limit is hit.
      assert.equal((await login(call, PASSWORD)).status, 429);
    });
  });

  it("does not count successful logins against the limit", async () => {
    await withServer(async (call) => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        assert.equal((await login(call, PASSWORD)).status, 200);
      }
    });
  });
});

describe("protected routes", () => {
  it("rejects a request with no cookie", async () => {
    await withServer(async (call) => {
      const response = await call("/api/session");
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "Authentication required" });
    });
  });

  it("accepts a request carrying the session cookie", async () => {
    await withServer(async (call) => {
      const cookie = sessionCookie(await login(call, PASSWORD)).split(";")[0];
      const response = await call("/api/session", { headers: { cookie } });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.authenticated, true);
      assert.ok(new Date(body.expiresAt) > new Date());
    });
  });

  it("rejects a malformed token with 401, not 500", async () => {
    await withServer(async (call) => {
      for (const value of ["not-a-jwt", "a.b.c", "", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9"]) {
        const response = await call("/api/session", { headers: { cookie: `ht_session=${value}` } });
        assert.equal(response.status, 401, `token "${value}" should be 401`);
        assert.match((await response.json()).error, /Invalid session|Authentication required/);
      }
    });
  });

  it("rejects an expired token with 401", async () => {
    await withServer(async (call) => {
      const expired = jwt.sign({}, TEST_SECRET, {
        algorithm: "HS256",
        subject: "owner",
        expiresIn: "-1s",
      });
      const response = await call("/api/session", { headers: { cookie: `ht_session=${expired}` } });

      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "Session expired" });
    });
  });

  it("rejects a token signed with a different secret", async () => {
    await withServer(async (call) => {
      const forged = jwt.sign({}, "an-attackers-own-secret-value-of-sufficient-length", {
        algorithm: "HS256",
        subject: "owner",
        expiresIn: "30d",
      });
      const response = await call("/api/session", { headers: { cookie: `ht_session=${forged}` } });

      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "Invalid session" });
    });
  });

  it("rejects an unsigned (alg=none) token", async () => {
    await withServer(async (call) => {
      const unsigned = jwt.sign({}, "", { algorithm: "none", subject: "owner", expiresIn: "30d" });
      const response = await call("/api/session", {
        headers: { cookie: `ht_session=${unsigned}` },
      });
      assert.equal(response.status, 401);
    });
  });

  it("returns 401, not 404, for unknown /api routes when unauthenticated", async () => {
    await withServer(async (call) => {
      assert.equal((await call("/api/habits")).status, 401);
    });
  });
});

describe("logout", () => {
  it("clears the cookie and is safe to call repeatedly", async () => {
    await withServer(async (call) => {
      const cookie = sessionCookie(await login(call, PASSWORD)).split(";")[0];

      const first = await call("/api/logout", { method: "POST", headers: { cookie } });
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { authenticated: false });

      const cleared = sessionCookie(first);
      assert.ok(cleared, "expected a clearing Set-Cookie");
      assert.match(cleared, /ht_session=;/);
      assert.match(cleared, /Expires=Thu, 01 Jan 1970/i);
      assert.match(cleared, /HttpOnly/i);

      // Called again, with no cookie at all, it still succeeds.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const repeat = await call("/api/logout", { method: "POST" });
        assert.equal(repeat.status, 200);
        assert.deepEqual(await repeat.json(), { authenticated: false });
      }
    });
  });
});

describe("health", () => {
  it("stays reachable without authentication", async () => {
    await withServer(async (call) => {
      const response = await call("/api/health");
      assert.notEqual(response.status, 401);
      assert.ok([200, 503].includes(response.status), `unexpected status ${response.status}`);
      assert.equal((await response.json()).status !== undefined, true);
    });
  });
});

describe("password hashing", () => {
  it("verifies the correct password and rejects near misses", async () => {
    const hash = await auth.hashPassword(PASSWORD);
    assert.equal(await auth.verifyPassword(PASSWORD, hash), true);
    assert.equal(await auth.verifyPassword(WRONG_PASSWORD, hash), false);
    assert.equal(await auth.verifyPassword(`${PASSWORD} `, hash), false);
    assert.equal(await auth.verifyPassword("", hash), false);
  });

  it("never stores the plaintext, and salts every hash differently", async () => {
    const hash = await auth.hashPassword(PASSWORD);
    assert.doesNotMatch(hash, new RegExp(PASSWORD));
    assert.notEqual(hash, await auth.hashPassword(PASSWORD));
    assert.match(hash, /^scrypt\.n=\d+,r=\d+,p=\d+\./);
  });

  it("returns false instead of throwing on a corrupt hash string", async () => {
    for (const bad of ["", "not-a-hash", "scrypt.n=x,r=8,p=1.aaa.bbb", "bcrypt.abc"]) {
      assert.equal(await auth.verifyPassword(PASSWORD, bad), false);
    }
  });
});

describe("configuration", () => {
  it("marks the cookie Secure in production and not in development", async () => {
    const captured = [];
    const res = { cookie: (name, value, options) => captured.push(options) };

    const previous = config.env;
    try {
      config.env = "production";
      auth.setSessionCookie(res, "token");
      config.env = "development";
      auth.setSessionCookie(res, "token");
    } finally {
      config.env = previous;
    }

    assert.equal(captured[0].secure, true, "production cookie must be Secure");
    assert.equal(captured[1].secure, false, "development cookie must not be Secure");
    for (const options of captured) {
      assert.equal(options.httpOnly, true);
      assert.equal(options.sameSite, "lax");
      assert.equal(options.path, "/");
    }
  });

  it("refuses to start when auth secrets are missing or weak", () => {
    const saved = { ...config.auth };
    const cases = [
      { patch: { passwordHash: "" }, expect: /AUTH_PASSWORD_HASH is not set/ },
      { patch: { passwordHash: "garbage" }, expect: /not a valid scrypt hash/ },
      { patch: { secret: "" }, expect: /SESSION_SECRET is not set/ },
      { patch: { secret: "too-short" }, expect: /at least 32 characters/ },
      { patch: { ttlDays: 0 }, expect: /SESSION_TTL_DAYS must be a positive/ },
      { patch: { ttlDays: Number.NaN }, expect: /SESSION_TTL_DAYS must be a positive/ },
    ];

    for (const { patch, expect } of cases) {
      Object.assign(config.auth, saved, patch);
      assert.throws(() => auth.assertAuthConfig(), expect);
      // The failure message must never contain the secret or the hash itself.
      try {
        auth.assertAuthConfig();
      } catch (error) {
        assert.doesNotMatch(error.message, new RegExp(saved.secret));
        assert.doesNotMatch(error.message, /scrypt\.n=/);
      }
    }

    Object.assign(config.auth, saved);
    assert.doesNotThrow(() => auth.assertAuthConfig());
  });
});
