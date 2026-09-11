/**
 * Validation primitives shared across feature modules.
 *
 * Only genuinely cross-module pieces live here. A schema used by one module
 * belongs at the top of that module's controller, next to the handler that
 * parses with it.
 *
 * Controllers call `.parse()` and let the ZodError propagate: Express 5 forwards
 * a rejected async handler on its own, and the error handler already turns a
 * ZodError into a 400 carrying only `path` and `message`. There is deliberately
 * no validate() middleware and no asyncHandler.
 */
import { z } from "zod";

import { isIsoDate, isIsoMonth } from "./dates.js";

/** The largest value a Postgres bigint can hold. */
const MAX_BIGINT = 9223372036854775807n;

/**
 * Row ids are bigint, and node-postgres returns bigint as a *string* — there is
 * no type-parser override for oid 20, only for DATE. So ids are strings the
 * whole way through: JSON in, JSON out, straight back into a query parameter.
 * Parsing them into numbers would be lossy above 2^53 and buys nothing.
 *
 * The range check is load-bearing, not decoration. A digits-only string longer
 * than bigint reaches Postgres as a parameter and raises SQLSTATE 22003, which
 * carries no status and so becomes a 500 — for what is only ever a request for a
 * row that cannot exist.
 */
export const idParam = z
  .string()
  // One self-contained predicate rather than .regex().refine(): zod runs every
  // check, so a refinement that assumed the pattern had already passed would
  // call BigInt("abc"), throw, and turn a clean 400 into a 500.
  .refine((value) => /^\d+$/.test(value) && BigInt(value) <= MAX_BIGINT, "must be a numeric id");

/**
 * A calendar date. The refine is load-bearing: the pattern alone accepts
 * '2026-02-31', which Postgres rejects as a 500 rather than a 400.
 */
export const isoDate = z.string().refine(isIsoDate, "must be a date as YYYY-MM-DD");

/** A month, as YYYY-MM. Monthly journal entries and the monthly review use it. */
export const isoMonth = z.string().refine(isIsoMonth, "must be a month as YYYY-MM");
