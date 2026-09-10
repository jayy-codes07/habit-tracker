import { ZodError } from "zod";

import { isProduction } from "../config/index.js";
import { AppError } from "../lib/errors.js";

/**
 * Mounted after the authentication boundary, so an unauthenticated caller gets
 * 401 rather than a 404 that would map out which routes exist.
 */
export function notFoundHandler(_req, res) {
  res.status(404).json({ error: "Not found" });
}

/**
 * Last in the chain. Express identifies error handlers by arity, so all four
 * parameters must stay even though `next` is unused.
 */
export function errorHandler(error, _req, res, _next) {
  // Expected failures. A 4xx here is the API working, not an incident, so it is
  // answered without a log line; a 5xx someone raised deliberately still is one.
  if (error instanceof AppError) {
    if (error.status >= 500) {
      console.error("[api] error:", error);
    }
    return res.status(error.status).json({ error: error.message, ...error.extra });
  }

  // Invalid input. Only the path and message are forwarded — never issue.input,
  // which would echo the rejected value straight back into the response body.
  // (Auth deliberately does not validate with zod: its failures must stay one
  // generic message, and nothing there may be reflected at all.)
  if (error instanceof ZodError) {
    return res.status(400).json({
      error: "Invalid request",
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  // Anything else is a bug.
  // Logs the error only. Request bodies, cookies and auth headers never reach here.
  console.error("[api] unhandled error:", error);

  res.status(500).json({
    error: "Internal server error",
    ...(isProduction ? {} : { detail: error.message }),
  });
}
