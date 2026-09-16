import { sendJson } from "../../lib/api-client";
import type { BackupSummary, RestoreResult } from "../../types";

/**
 * The download is deliberately NOT here: it is a plain <a download> to
 * /api/export, because the endpoint already sends Content-Disposition with a
 * dated filename and the cookie rides along on a same-origin navigation.
 * Fetching it into a blob would be more code for a worse result — no progress,
 * and no native "keep" dialog on a phone.
 */

/** Validates the file and counts it. Writes nothing. */
export const checkBackup = (document: unknown) =>
  sendJson<BackupSummary>("POST", "/import/check", document);

/** Replaces everything with the file. All of it, or none of it. */
export const restoreBackup = (document: unknown) =>
  sendJson<RestoreResult>("POST", "/import", document);

/*
 * When a backup was last downloaded, as a bare ISO instant.
 *
 * localStorage, not the server: the server knows when the export endpoint was
 * called, and the thing worth knowing is whether the FILE is somewhere safe,
 * which only this browser can even guess at. Wrapped because Safari's private
 * mode throws on write, and a settings screen must not be the thing that
 * crashes.
 */
const KEY = "habit-tracker:last-backup";

export function readLastBackup(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function stampLastBackup(): string {
  const now = new Date().toISOString();
  try {
    localStorage.setItem(KEY, now);
  } catch {
    /* Nothing to do: the file downloaded either way. */
  }
  return now;
}
