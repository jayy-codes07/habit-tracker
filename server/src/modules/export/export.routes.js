import { Router } from "express";

import { exportAll } from "./export.controller.js";

export function createExportRouter() {
  const router = Router();
  router.get("/export", exportAll);
  return router;
}
