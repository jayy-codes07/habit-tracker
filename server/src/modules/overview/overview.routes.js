import { Router } from "express";

import { compare, day, grid, review } from "./overview.controller.js";

/**
 * Mounted without a prefix: these are whole-screen reads that do not belong to
 * any one feature, so each declares its own top-level path.
 */
export function createOverviewRouter() {
  const router = Router();

  router.get("/day/:date", day);
  router.get("/grid", grid);
  router.get("/review/:month", review);
  // The same month a year apart. Its own path rather than a flag on /review:
  // the review is one month read in full, this is two months read as counts,
  // and folding the second into the first would make every review pay for it.
  router.get("/compare/:month", compare);

  return router;
}
