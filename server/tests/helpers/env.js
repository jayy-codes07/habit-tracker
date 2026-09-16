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

/*
 * Cloudinary, configured with values that are deliberately not an account.
 *
 * The tests never reach the network: leetcode.test.js replaces the SDK's
 * uploader with a fake and asserts on what the app did with the answer. What
 * these three do is get past assertConfigured(), which is the guard that keeps
 * a credential-less deployment from failing at the first upload instead of at
 * the first request — so the test run must set them the same way a real
 * environment does, rather than the app having a test mode.
 */
process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
process.env.CLOUDINARY_API_KEY = "test-key";
process.env.CLOUDINARY_API_SECRET = "test-secret";
