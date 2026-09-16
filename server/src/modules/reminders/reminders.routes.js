import { Router } from "express";

import { settings, subscribe, unsubscribe, update } from "./reminders.controller.js";

/**
 * Delivery is a push from the server now, so there is no "what is due" endpoint
 * for a page to poll: the scheduler asks, and the push service carries it to a
 * device that may have nothing of ours running. What is left here is the
 * settings row and the two calls that register a device.
 */
export function createRemindersRouter() {
  const router = Router();

  router.get("/", settings);
  router.patch("/", update);
  router.post("/subscription", subscribe);
  router.delete("/subscription", unsubscribe);

  return router;
}
