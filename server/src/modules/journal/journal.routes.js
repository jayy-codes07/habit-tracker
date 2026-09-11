import { Router } from "express";

import {
  deleteDay,
  deleteMonth,
  getDay,
  getMonth,
  putDay,
  putMonth,
} from "./journal.controller.js";

export function createJournalRouter() {
  const router = Router();

  // DELETE is how an entry is cleared: the not-blank constraint means an empty
  // entry cannot be stored, so "saved an empty box" has to mean remove.
  router.get("/day/:date", getDay);
  router.put("/day/:date", putDay);
  router.delete("/day/:date", deleteDay);

  router.get("/month/:month", getMonth);
  router.put("/month/:month", putMonth);
  router.delete("/month/:month", deleteMonth);

  return router;
}
