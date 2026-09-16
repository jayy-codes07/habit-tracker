import express, { Router } from "express";

import { exportAll, importBackup, inspectBackup } from "./export.controller.js";

/**
 * The app-wide parser is 1mb, which is right for every other route here and
 * far too small for the one thing that is deliberately the whole database.
 * Years of habit logs plus a few hundred LeetCode solutions is tens of
 * megabytes of JSON, and the 1mb limit rejects it as a 413 with no clue that
 * the file was fine — so these two routes mount their own, as the screenshot
 * upload mounts express.raw on its own.
 *
 * 64mb is a ceiling, not a target: the body is parsed into memory and a limit
 * of none is a way to be killed by a file someone points at the endpoint.
 */
const backupBody = express.json({ limit: "64mb" });

export function createExportRouter() {
  const router = Router();
  router.get("/export", exportAll);
  // Check before replace: this one answers what the file holds and writes
  // nothing, so the confirmation on the other side is informed.
  router.post("/import/check", backupBody, inspectBackup);
  router.post("/import", backupBody, importBackup);
  return router;
}
