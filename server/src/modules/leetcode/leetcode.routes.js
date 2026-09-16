import express, { Router } from "express";

import {
  create,
  deleteScreenshot,
  detail,
  getScreenshot,
  list,
  putScreenshot,
  remove,
  update,
} from "./leetcode.controller.js";

/**
 * The formats a screenshot may arrive as, and the ceiling on one.
 *
 * express.raw refuses anything outside this list before a byte is buffered,
 * which is what keeps the 5MB limit from being a limit on arbitrary uploads.
 * SVG is absent deliberately — see the note in leetcode.service.js.
 *
 * 5MB is roughly a full-width screenshot of a problem statement on a retina
 * display, with room to spare. The app's global express.json limit is 1MB and
 * stays that way: this is the one route that carries a file, and raising the
 * JSON limit for it would raise it for every endpoint.
 */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const SCREENSHOT_LIMIT = "5mb";

export function createLeetcodeRouter() {
  const router = Router();

  router.get("/", list);
  router.post("/", create);

  router.get("/:id", detail);
  router.patch("/:id", update);
  // Removal is normally PATCH { archived: true }. This is the escape hatch for
  // a mistyped entry and refuses anything that has become a record — see
  // deleteProblem.
  router.delete("/:id", remove);

  router.get("/:id/screenshot", getScreenshot);
  // Raw bytes, not multipart — see putScreenshot. The parser is mounted here
  // rather than globally so no other route can be handed a Buffer body.
  router.put(
    "/:id/screenshot",
    express.raw({ type: IMAGE_TYPES, limit: SCREENSHOT_LIMIT }),
    putScreenshot,
  );
  // A screenshot, unlike a problem, IS deletable: it is one replaceable
  // attachment rather than a record of something that happened.
  router.delete("/:id/screenshot", deleteScreenshot);

  return router;
}
