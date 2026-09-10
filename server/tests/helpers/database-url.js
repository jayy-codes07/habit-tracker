/**
 * Where the tests' database lives, and the guard that keeps them off yours.
 *
 * Pure resolution only — importing this must not connect to anything or mutate
 * process.env, because both the --import bootstrap and the setup script need the
 * answer at different moments.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url)); // server/tests/helpers
const paths = {
  server: resolve(here, "..", ".."),
  repo: resolve(here, "..", "..", ".."),
};

let envFilesLoaded = false;

/** Mirrors src/config: server/.env first, then the repo root, real env wins. */
function loadEnvFiles() {
  if (envFilesLoaded) return;
  dotenv.config({
    path: [resolve(paths.server, ".env"), resolve(paths.repo, ".env")],
    quiet: true,
  });
  envFilesLoaded = true;
}

/** The database name from a connection URL, e.g. 'habit_tracker'. */
export function databaseNameOf(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/**
 * Tests write freely and roll back; pointed at the development database they
 * would still hold locks on it, and a bug in the harness would destroy it. The
 * name is the only thing standing between the two, so it is checked every time.
 */
export function assertTestDatabase(url) {
  let name;
  try {
    name = databaseNameOf(url);
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid connection URL.");
  }

  if (!name.endsWith("_test")) {
    throw new Error(
      `Refusing to run tests against database "${name}": the name must end with _test. ` +
        "Set TEST_DATABASE_URL to a throwaway database.",
    );
  }
  return name;
}

/**
 * TEST_DATABASE_URL when set, otherwise DATABASE_URL with '_test' appended to
 * the database name. Deriving it means the same command works on the host and
 * inside Compose, where the host is 'db' rather than localhost.
 */
export function resolveTestDatabaseUrl() {
  loadEnvFiles();

  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) {
    assertTestDatabase(explicit);
    return explicit;
  }

  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "Set TEST_DATABASE_URL, or DATABASE_URL for the test database name to be derived from.",
    );
  }

  const name = databaseNameOf(base);
  const url = new URL(base);
  url.pathname = `/${name.endsWith("_test") ? name : `${name}_test`}`;

  const derived = url.toString();
  assertTestDatabase(derived);
  return derived;
}
