import { Router } from "express";

import { find } from "./search.controller.js";

/** Mounted at /search: one endpoint, and no tables of its own. */
export function createSearchRouter() {
  const router = Router();
  router.get("/", find);
  return router;
}
