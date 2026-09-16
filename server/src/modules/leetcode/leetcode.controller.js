/**
 * LeetCode workspace routes.
 *
 * Removal is PATCH { archived: true }. DELETE exists too, and the split is the
 * one habits already draw: you can delete a mistake, you must archive a record.
 * A problem carrying an approach, a solution or a screenshot is a record and
 * answers 409; one that is still just a title is a mistyped entry, and leaving
 * it in the recovery list for ever is not a correction.
 *
 * Reviewing is PATCH { reviewed: true } rather than a route of its own, because
 * it is not a separate operation on a problem — it is one of the facts a
 * problem holds, and undoing it is the same field going back to null.
 */
import { z } from "zod";

import { today } from "../../lib/dates.js";
import { badRequest } from "../../lib/errors.js";
import { idParam, isoDate } from "../../lib/schemas.js";
import * as leetcode from "./leetcode.service.js";

const title = z.string().trim().min(1).max(200);
const difficulty = z.enum(["easy", "medium", "hard"]);

/**
 * The LeetCode number. Capped well inside the column's `integer` range: a value
 * above it reaches Postgres as a parameter and raises SQLSTATE 22003, which
 * carries no status and would answer 500 for what is plainly a bad request.
 */
const number = z.number().int().positive().max(1_000_000);

/**
 * Tags, normalised here so the same topic typed three ways is one topic. Deduped
 * before the count is checked — nine tags of which two are the same is eight
 * tags, and refusing it would be the API arguing about its own normalisation.
 */
const topics = z
  .array(z.string().trim().toLowerCase().min(1).max(30))
  .transform((list) => [...new Set(list)])
  .refine((list) => list.length <= 8, "at most 8 topics");

/**
 * Case-sensitive on purpose: the matching CHECK constraint is `~ '^https?://'`,
 * which Postgres evaluates case-sensitively. A pattern here that accepted
 * "HTTPS://" would turn a 400 into a constraint violation, and a 500.
 *
 * The scheme allowlist is the point, not the tidiness. This value is rendered
 * into an href, and "javascript:" in one is script execution on click.
 */
const url = z
  .string()
  .trim()
  .max(500)
  .refine((value) => /^https?:\/\//.test(value), "must be an http:// or https:// URL");

const approach = z.string().max(20_000);
const solution = z.string().max(40_000);

const createBody = z.object({
  number: number.nullish(),
  title,
  difficulty,
  topics: topics.optional(),
  url: url.nullish(),
  // Absent means the app's today, resolved on the server. The client never
  // sends its own clock's date for this.
  solved_on: isoDate.optional(),
  ai_assisted: z.boolean().optional(),
  approach: approach.nullish(),
  solution: solution.nullish(),
});

/**
 * Every field is optional, and the nullable ones are nullish rather than
 * optional: sending null CLEARS the field, which is a different instruction
 * from leaving it out. The service reads presence, not value, to tell them
 * apart.
 *
 * `topics` is the exception — optional but never null. The column is NOT NULL
 * with a '{}' default, so clearing every tag is an empty array.
 */
const updateBody = z
  .object({
    number: number.nullish(),
    title: title.optional(),
    difficulty: difficulty.optional(),
    topics: topics.optional(),
    url: url.nullish(),
    solved_on: isoDate.optional(),
    ai_assisted: z.boolean().optional(),
    approach: approach.nullish(),
    solution: solution.nullish(),
    // The two state changes. Booleans on the wire, dates in the table.
    reviewed: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "nothing to update");

/**
 * Two mutually exclusive views of the table. There is no "needs review" scope:
 * the queue is derived from two columns the active list already carries, and a
 * server-side filter for it would be a second read of the same rows that can
 * disagree with the first.
 */
const listQuery = z.object({ scope: z.enum(["active", "archived"]).optional() });

/**
 * `today` rides along for the same reason it does on /tasks and /day: it is the
 * app's own calendar day, and the client must not decide from its own clock how
 * long ago something was solved or what date to offer for a new entry.
 */
export async function list(req, res) {
  const { scope } = listQuery.parse(req.query);
  res.json({
    problems: await leetcode.loadProblems({ archived: scope === "archived" }),
    today: today(),
  });
}

export async function detail(req, res) {
  const id = idParam.parse(req.params.id);
  res.json({ problem: await leetcode.loadProblem(id), today: today() });
}

export async function create(req, res) {
  const body = createBody.parse(req.body);
  res.status(201).json({ problem: await leetcode.createProblem(body) });
}

export async function update(req, res) {
  const id = idParam.parse(req.params.id);
  const { reviewed, archived, ...patch } = updateBody.parse(req.body);
  res.json({ problem: await leetcode.updateProblem(id, patch, { reviewed, archived }) });
}

/**
 * The upload, as raw bytes rather than multipart.
 *
 * A single-file body needs no form encoding, and skipping it means no multipart
 * parser and no dependency: the browser sends the File as the body and this
 * reads req.body, which express.raw has already buffered. The trade is that
 * there is nowhere to put a field alongside the file, which is fine — every
 * other field belongs to the problem and is already stored.
 *
 * express.raw only produces a Buffer when the Content-Type matched its allowed
 * list, so anything else arrives as an empty object and is refused here. The
 * service then checks the bytes themselves against the declared type, and only
 * then do they leave this process for the media store.
 */
export async function putScreenshot(req, res) {
  const id = idParam.parse(req.params.id);

  if (!Buffer.isBuffer(req.body)) {
    throw badRequest("Send the image as the request body, with its own Content-Type");
  }

  // The header can carry parameters ("image/png; charset=binary"); the media
  // type alone is what is stored and what is compared against the bytes.
  const declared = (req.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

  res.json({ problem: await leetcode.setScreenshot(id, req.body, declared) });
}

/** 204, 409 or 404 from one snapshot — see deleteProblem. */
export async function remove(req, res) {
  const id = idParam.parse(req.params.id);
  await leetcode.deleteProblem(id);
  res.status(204).end();
}

export async function deleteScreenshot(req, res) {
  const id = idParam.parse(req.params.id);
  await leetcode.clearScreenshot(id);
  res.status(204).end();
}
