/**
 * Search: one query parameter, one list back.
 */
import { z } from "zod";

import * as search from "./search.service.js";

/**
 * A single character matches most of the record, so the floor is two. The
 * ceiling on `limit` is what stops one request from returning the whole
 * journal — /api/export is the endpoint for that.
 */
const searchQuery = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function find(req, res) {
  const { q, limit } = searchQuery.parse(req.query);
  res.json({ query: q, ...(await search.search(q, { limit })) });
}
