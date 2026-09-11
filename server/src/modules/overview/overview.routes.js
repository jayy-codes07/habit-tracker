import { Router } from "express";

import { day, grid, review } from "./overview.controller.js";

/**
 * Mounted without a prefix: these are whole-screen reads that do not belong to
 * any one feature, so each declares its own top-level path.
 */
export function createOverviewRouter() {
  const router = Router();

  router.get("/day/:date", day);
  router.get("/grid", grid);
  router.get("/review/:month", review);

  return router;
}
