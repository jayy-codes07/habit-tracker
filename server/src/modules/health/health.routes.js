import { Router } from "express";

import { health } from "./health.controller.js";

export function createHealthRouter() {
  const router = Router();
  router.get("/health", health);
  return router;
}
