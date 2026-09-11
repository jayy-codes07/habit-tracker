import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url)); // server/src/config

/** Resolved once so nothing else has to count "../" levels. */
export const paths = {
  server: resolve(here, "..", ".."), // server/
  repo: resolve(here, "..", "..", ".."), // repository root
};

// The single .env lives at the repo root, next to docker-compose.yml, but these
// scripts run from server/. Load both, server first; real environment variables
// (what Compose and the production platform inject) always win over the files.
dotenv.config({
  path: [resolve(paths.server, ".env"), resolve(paths.repo, ".env")],
  quiet: true, // no startup banner on stdout; it would corrupt piped output
});

/**
 * Rejects a bad IANA zone at boot rather than at the first request that needs
 * today's date. Intl is the only authority on what zones exist, and it throws a
 * RangeError on an unknown one; catching that here is cheaper than discovering
 * it as a 500 weeks later. Done inline rather than via lib/dates.js, which
 * imports this module.
 */
function timeZone(name) {
  const value = process.env[name] ?? "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
  } catch {
    throw new Error(`${name} is not a valid IANA time zone: ${value}`);
  }
  return value;
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export const config = {
  env: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),

  // The calendar day the app is living in. A habit is done on a day, and the
  // container runs UTC, so without this the day rolls over at the wrong moment
  // for any other zone and streaks read wrongly for part of every day.
  timezone: timeZone("APP_TIMEZONE"),

  databaseUrl: required("DATABASE_URL"),
  // Managed Postgres requires TLS; the local container does not offer it.
  databaseSsl: process.env.DATABASE_SSL === "true",

  // Read, not validated, here: assertAuthConfig() checks these when the app is
  // created, so the migrate and seed commands still run without them.
  auth: {
    passwordHash: process.env.AUTH_PASSWORD_HASH ?? "",
    secret: process.env.SESSION_SECRET ?? "",
    // Long enough not to nag on a phone used daily, short enough that a stolen
    // cookie is not a permanent key.
    ttlDays: Number(process.env.SESSION_TTL_DAYS ?? 30),
  },

  // Where the built SPA lands. Absent until the frontend exists, which is fine:
  // the server serves the API alone until then.
  webDistPath: resolve(paths.repo, process.env.WEB_DIST_PATH ?? "web/dist"),
};

export const isProduction = config.env === "production";
