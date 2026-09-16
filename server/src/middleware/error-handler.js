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

  /*
   * Body-parser rejections: a body over the limit, or one that would not parse.
   *
   * They are neither AppError nor ZodError, so without this branch a screenshot
   * a megabyte too big and a stray brace in a JSON body both answered 500 and
   * were logged as bugs — an incident report for a caller mistake the parser
   * had already diagnosed correctly.
   *
   * `expose` is set by body-parser only for statuses below 500, so it is the
   * check for "safe to answer with". The message is NOT forwarded: a parse
   * failure names the character it choked on, which is the submitted body
   * coming back out, and this handler does not echo rejected input anywhere
   * else either.
   */
  if (error.expose === true && error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({
      error: error.status === 413 ? "That upload is too large." : "Malformed request body.",
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
