/**
 * The aggregate read endpoints.
 *
 * Each of these answers one screen in one request, which is the whole point:
 * assembling a day out of four separate calls is four round trips on a phone
 * before anything appears.
 */
import { z } from "zod";

import { today } from "../../lib/dates.js";
import { isoDate, isoMonth } from "../../lib/schemas.js";
import * as overview from "./overview.service.js";

/**
 * Five years of weeks is the ceiling, and the sheet is a scroller rather than a
 * fit — a long range makes the columns further to scroll, never smaller, so the
 * limit is about how much record it is sane to ask for in one read and not
 * about how much fits on a screen. 261 weeks of one habit is 1,827 characters.
 *
 * It was a single year, which is the range the product had. Reading the record
 * across several years is what pushed it out; beyond five, this stops being a
 * grid anyone scrolls and /api/export is the endpoint for that.
 */
const gridQuery = z.object({
  end: isoDate.optional(),
  // Query parameters arrive as strings, so this has to coerce before it checks.
  weeks: z.coerce.number().int().min(1).max(261).default(12),
});

export async function day(req, res) {
  res.json(await overview.buildDay(isoDate.parse(req.params.date)));
}

export async function grid(req, res) {
  const { end, weeks } = gridQuery.parse(req.query);
  res.json(await overview.buildGrid({ end: end ?? today(), weeks }));
}

export async function review(req, res) {
  res.json(await overview.buildReview(isoMonth.parse(req.params.month)));
}

/** This month's figures beside the same month a year ago. See buildCompare. */
export async function compare(req, res) {
  res.json(await overview.buildCompare(isoMonth.parse(req.params.month)));
}
