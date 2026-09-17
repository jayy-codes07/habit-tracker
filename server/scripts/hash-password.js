/**
 * Generates the value for AUTH_PASSWORD_HASH.
 *
 *   npm run hash-password
 *
 * The password is read from stdin, never from argv, so it cannot end up in shell
 * history or in the process list. Terminal echo is disabled while typing. The
 * plaintext is never printed, logged or written anywhere - only the hash goes to
 * stdout, so `npm run hash-password >> ../.env` also works.
 */
import { createInterface } from "node:readline";

import {
  hashPassword,
  parsePasswordHash,
  verifyPassword,
} from "../src/modules/auth/auth.service.js";

const interactive = process.stdin.isTTY === true;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Two prompts with echo suppressed. */
async function readInteractive() {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });

  const ask = (question) =>
    new Promise((resolve) => {
      // Swallow echoed characters so the password never appears on screen.
      rl._writeToOutput = (chunk) => {
        if (chunk.includes(question)) process.stderr.write(question);
      };
      rl.question(question, (answer) => {
        process.stderr.write("\n");
        resolve(answer);
      });
    });

  try {
    return [await ask("Password: "), await ask("Confirm:  ")];
  } finally {
    rl.close();
  }
}

/**
 * Piped input is consumed in one read rather than through readline: at EOF the
 * interface closes, and a second queued question would never receive its callback.
 */
async function readPiped() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}

const [first = "", second = ""] = interactive ? await readInteractive() : await readPiped();
const password = first.trim();
const confirmation = second.trim();

if (password.length < 8) {
  fail("Refusing: use at least 8 characters. This is the only credential.");
}
if (confirmation !== password) {
  fail("Refusing: the two entries did not match.");
}

const hash = await hashPassword(password);

// Prove the stored form round-trips before handing it over.
if (!parsePasswordHash(hash) || !(await verifyPassword(password, hash))) {
  fail("Internal error: generated hash failed its own verification.");
}

process.stderr.write("\nAdd this line to .env (keep it out of git):\n\n");
process.stdout.write(`AUTH_PASSWORD_HASH=${hash}\n`);
