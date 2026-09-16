import { Router } from "express";

import {
  changeSchedule,
  clearLog,
  create,
  history,
  list,
  remove,
  reorder,
  setLog,
  update,
} from "./habits.controller.js";

export function createHabitsRouter() {
  const router = Router();

  router.get("/", list);
  router.post("/", create);

  // Before "/:id" so the literal path is never read as an id. The methods
  // happen to differ today, but relying on that would break the first time
  // someone adds PUT /:id.
  router.put("/order", reorder);

  // One habit's whole life. GET "/:id" does not exist, so there is nothing for
  // this to be read as instead.
  router.get("/:id/history", history);

  router.patch("/:id", update);
  router.delete("/:id", remove);

  router.post("/:id/schedule", changeSchedule);

  router.put("/:id/logs/:date", setLog);
  router.delete("/:id/logs/:date", clearLog);

  return router;
}
