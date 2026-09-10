import { isProduction } from "../config/index.js";

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
  // Logs the error only. Request bodies, cookies and auth headers never reach here.
  console.error("[api] unhandled error:", error);

  res.status(500).json({
    error: "Internal server error",
    ...(isProduction ? {} : { detail: error.message }),
  });
}
