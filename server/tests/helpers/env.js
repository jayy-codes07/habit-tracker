/**
 * Test bootstrap, loaded with `node --test --import ./tests/helpers/env.js`.
 *
 * It has to run before any test file, because src/config snapshots process.env
 * the first time it is imported and src/db builds its pool from that snapshot
 * immediately. Doing this inside a test's before() hook would be too late: the
 * pool would already be pointing at the development database. --import
 * guarantees the ordering no matter which module a test file imports first.
 */
import { resolveTestDatabaseUrl } from "./database-url.js";

process.env.DATABASE_URL = resolveTestDatabaseUrl();
