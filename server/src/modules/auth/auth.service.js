/**
 * Authentication for a single-user personal app.
 *
 * There is no users table and no user id: the only subject is the owner. The
 * server keeps no session state — the signed cookie is the entire session — so
 * restarts and multiple instances need no coordination.
 *
 * Password hashing uses scrypt from node:crypto. It is memory-hard (unlike
 * bcrypt) and needs no native module, which keeps the alpine image buildable and
 * the dependency list honest for a one-password app. The stored format records
 * its own parameters, so they can be raised later without invalidating the
 * existing hash, and a move to argon2id would be a drop-in replacement.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import jwt from "jsonwebtoken";

import { config } from "../../config/index.js";

const scrypt = promisify(scryptCallback);

// N=65536, r=8 costs roughly 64MB and ~100ms per verification — far too slow to
// brute force, imperceptible when logging in once a month.
const SCRYPT_PARAMS = { N: 65_536, r: 8, p: 1 };
const KEY_LENGTH = 32;
const MAX_MEMORY = 256 * 1024 * 1024;

export const SESSION_COOKIE = "ht_session";
const TOKEN_SUBJECT = "owner";

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

/**
 * Produces `scrypt.n=...,r=...,p=....<salt>.<hash>` — the parameters travel with
 * the hash, so they can be raised later without invalidating what is stored.
 *
 * Deliberately NOT the PHC `$scrypt$...` convention: this string lives in an
 * environment variable that passes through .env files, Docker Compose
 * interpolation and shells, all of which treat `$` as a variable sigil and would
 * silently corrupt it. base64url avoids `+`, `/` and `=` for the same reason.
 */
export async function hashPassword(plaintext) {
  const { N, r, p } = SCRYPT_PARAMS;
  const salt = randomBytes(16);
  const derived = await scrypt(plaintext, salt, KEY_LENGTH, { N, r, p, maxmem: MAX_MEMORY });
  return `scrypt.n=${N},r=${r},p=${p}.${salt.toString("base64url")}.${derived.toString("base64url")}`;
}

export function parsePasswordHash(stored) {
  const match = /^scrypt\.n=(\d+),r=(\d+),p=(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(
    stored ?? "",
  );
  if (!match) return null;
  return {
    N: Number(match[1]),
    r: Number(match[2]),
    p: Number(match[3]),
    salt: Buffer.from(match[4], "base64url"),
    hash: Buffer.from(match[5], "base64url"),
  };
}

/** Constant-time comparison. Returns false rather than throwing on a bad hash string. */
export async function verifyPassword(plaintext, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed || typeof plaintext !== "string" || plaintext.length === 0) return false;

  try {
    const derived = await scrypt(plaintext, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEMORY,
    });
    return timingSafeEqual(derived, parsed.hash);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session token
// ---------------------------------------------------------------------------

export function issueToken() {
  return jwt.sign({}, config.auth.secret, {
    algorithm: "HS256",
    subject: TOKEN_SUBJECT,
    expiresIn: `${config.auth.ttlDays}d`,
  });
}

/** Throws on malformed, tampered or expired tokens — callers turn that into a 401. */
export function verifyToken(token) {
  return jwt.verify(token, config.auth.secret, {
    algorithms: ["HS256"],
    subject: TOKEN_SUBJECT,
  });
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

/**
 * SameSite=Lax is correct because the SPA is served by this same Express app.
 * There is no cross-site request to accommodate, and Lax still blocks the
 * cross-site POSTs that CSRF depends on.
 */
function baseCookieOptions() {
  return {
    httpOnly: true,
    // Read at call time, not module-load time, so the flag reflects the running
    // configuration rather than whatever the environment was when this file was
    // first imported.
    secure: config.env === "production", // http://localhost must keep working in dev
    sameSite: "lax",
    path: "/",
  };
}

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    ...baseCookieOptions(),
    maxAge: config.auth.ttlDays * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res) {
  // Same attributes as when it was set, or the browser will not match and clear it.
  res.clearCookie(SESSION_COOKIE, baseCookieOptions());
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

const MIN_SECRET_LENGTH = 32;

/**
 * Fails loudly at boot rather than at the first login attempt. Never includes the
 * secret or hash in the message.
 */
export function assertAuthConfig() {
  const problems = [];

  if (!config.auth.passwordHash) {
    problems.push("AUTH_PASSWORD_HASH is not set (generate one with: npm run hash-password)");
  } else if (!parsePasswordHash(config.auth.passwordHash)) {
    problems.push("AUTH_PASSWORD_HASH is not a valid scrypt hash string");
  }

  if (!config.auth.secret) {
    problems.push(
      "SESSION_SECRET is not set (generate one with: node -e \"console.log(require('node:crypto').randomBytes(48).toString('base64url'))\")",
    );
  } else if (config.auth.secret.length < MIN_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  if (!Number.isFinite(config.auth.ttlDays) || config.auth.ttlDays < 1) {
    problems.push("SESSION_TTL_DAYS must be a positive number of days");
  }

  if (problems.length > 0) {
    throw new Error(`Authentication is not configured:\n  - ${problems.join("\n  - ")}`);
  }
}
