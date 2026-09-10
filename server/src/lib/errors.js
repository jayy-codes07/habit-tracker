/**
 * Expected failures, as opposed to bugs.
 *
 * A route that throws one of these is saying "the request was wrong, and here is
 * the honest status for it". The error handler answers with that status and does
 * not log it: a 404 is not an incident, and logging every one buries the 500s
 * that actually matter.
 *
 * Anything else reaching the handler is a bug and still becomes a logged 500.
 */
export class AppError extends Error {
  /**
   * @param {number} status  HTTP status to answer with.
   * @param {string} message Sent to the client verbatim, so it must not carry
   *                         anything the caller should not see.
   * @param {object} [extra] Merged into the response body beside `error`.
   */
  constructor(status, message, extra = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.extra = extra;
  }
}

/** 400 — the request itself is malformed or contradictory. */
export const badRequest = (message, extra) => new AppError(400, message, extra);

/** 404 — no such row, or one the caller may not see. */
export const notFound = (message = "Not found", extra) => new AppError(404, message, extra);

/** 409 — valid, but it collides with what is already stored. */
export const conflict = (message, extra) => new AppError(409, message, extra);
