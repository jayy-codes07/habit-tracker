import { Router } from "express";

import { create, list, update } from "./tasks.controller.js";

export function createTasksRouter() {
  const router = Router();

  router.get("/", list);
  router.post("/", create);
  // No DELETE: removal is PATCH { archived: true }, so nothing is destroyed.
  router.patch("/:id", update);

  return router;
}
