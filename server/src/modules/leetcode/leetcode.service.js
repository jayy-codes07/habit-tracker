/**
 * The LeetCode workspace: one table, and one derived question.
 *
 * "Needs review" is never stored. It is `ai_assisted AND reviewed_on IS NULL`,
 * computed wherever it is asked, so the queue cannot drift away from the two
 * facts that produce it. Marking a problem reviewed writes a DATE — the day you
 * went back over it — and unmarking it writes NULL, which is the same row
 * returning to the queue rather than a second status being invented for it.
 *
 * Nothing here scores anything. There is no rate, no total, no best and no
 * column a streak could be built from; this is a record of what was solved and
 * what has been revisited, and that is the whole of it.
 *
 * Removal is archiving. The screenshot and the notes on a row are worth more
 * than a task's title, so nothing a single click does here is irreversible, and
 * every working read filters `archived_at IS NULL`. deleteProblem is the narrow
 * exception habits already draw: a row that has become a record can only be
 * archived, a row that is still just a mistyped title can go.
 */
import { config } from "../../config/index.js";
import { query } from "../../db/index.js";
import { today } from "../../lib/dates.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";

/**
 * What a list row carries.
 *
 * `approach` and `solution` are absent on purpose: they are the longest columns
 * in the table and the index only ever renders a title. A few hundred rows each
 * carrying a page of prose is a payload the workspace reloads on every write,
 * for text no list has ever shown.
 *
 * `screenshot` is absent for a harder reason — naming it would drag every row's
 * TOASTed image through the connection just to answer "is there one". The byte
 * count answers that, and is a fact worth showing anyway.
 */
const LIST_COLUMNS = `id, number, title, difficulty, topics, url, solved_on,
                      ai_assisted, reviewed_on, screenshot_bytes,
                      created_at, updated_at, archived_at`;

/** The detail read adds the two long columns, and still never the bytes. */
const DETAIL_COLUMNS = `${LIST_COLUMNS}, approach, solution`;

/**
 * The calendar day the row was archived on, in the app's own zone — the same
 * cast tasks.service.js and habits.service.js make, for the same reason.
 * Slicing the instant's ISO string on the client would pin the label to UTC,
 * which is nobody's calendar.
 */
const ARCHIVED_ON = "(archived_at AT TIME ZONE $1)::date AS archived_on";

/**
 * Every column a PATCH may set directly, as a fixed allowlist.
 *
 * The update below builds its SET clause from this rather than taking the tasks
 * module's COALESCE-and-CASE shape, and the reason is the four nullable fields.
 * COALESCE cannot tell "leave it alone" from "clear it", so tasks carries one
 * extra boolean parameter per nullable column to say which was meant; with four
 * of them that is eight parameters of ceremony around one idea. Presence in the
 * parsed body IS the answer, so the loop asks that question directly.
 *
 * The keys are this constant, never the request's — a column name interpolated
 * from user input would be an injection site, and the allowlist is what makes
 * the interpolation below safe to read.
 */
const PATCHABLE = [
  "number",
  "title",
  "difficulty",
  "topics",
  "url",
  "solved_on",
  "ai_assisted",
  "approach",
  "solution",
];

/**
 * The stored screenshot formats.
 *
 * SVG is deliberately absent and must stay absent: it can carry script, and
 * this app serves the bytes back from its own origin behind an <img> tag, where
 * one would run as the page. The same list is a CHECK on the column.
 */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What the bytes actually are, or null if they are not an image we store.
 *
 * The declared Content-Type is attacker-chosen in the general case and simply
 * mis-detected in the ordinary one — a clipboard that labels a WebP as a PNG.
 * Either way the header is a claim rather than evidence, and the value ends up
 * echoed straight back into a response Content-Type, so it is checked against
 * the bytes before it is stored.
 */
function sniff(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";

  // JPEG's SOI plus the first marker byte. The fourth byte varies by segment
  // (JFIF, Exif, raw), so three is as far as a signature check can honestly go.
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // A RIFF container with "WEBP" at offset 8; the four bytes between are its
  // length. latin1 because these are byte values, not text in any encoding.
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The working list, or the archived mirror.
 *
 * Ordered newest solve first, because the thing you just did is the thing you
 * are most likely to still be writing about. The archived list is ordered by
 * when it was removed instead — a recovery list answers "what did I just throw
 * away", which is a different question from "what have I been working on".
 *
 * There is deliberately no `scope=review`. The queue is `ai_assisted AND
 * reviewed_on IS NULL` over rows the client already holds, so asking the server
 * for it would be a second read of the same data that can disagree with the
 * first.
 */
export async function loadProblems({ archived = false } = {}) {
  if (archived) {
    const { rows } = await query(
      `SELECT ${LIST_COLUMNS}, ${ARCHIVED_ON}
         FROM leetcode_problems
        WHERE archived_at IS NOT NULL
        ORDER BY archived_at DESC, id DESC`,
      [config.timezone],
    );
    return rows;
  }

  const { rows } = await query(
    `SELECT ${LIST_COLUMNS}
       FROM leetcode_problems
      WHERE archived_at IS NULL
      ORDER BY solved_on DESC, id DESC`,
  );
  return rows;
}

/**
 * One problem, archived or not.
 *
 * No archived filter, deliberately: /leetcode/:id has to open an archived row
 * or there is no screen to restore it from, and a bookmark to one must not
 * start answering 404 because the row was tidied away.
 */
export async function loadProblem(id) {
  const { rows } = await query(
    `SELECT ${DETAIL_COLUMNS}, ${ARCHIVED_ON} FROM leetcode_problems WHERE id = $2`,
    [config.timezone, id],
  );
  if (rows.length === 0) throw notFound("No such problem");
  return rows[0];
}

/** The bytes and their type, or null when the row carries no screenshot. */
export async function loadScreenshot(id) {
  const { rows } = await query(
    "SELECT screenshot, screenshot_type FROM leetcode_problems WHERE id = $1",
    [id],
  );
  if (rows.length === 0) throw notFound("No such problem");
  return rows[0].screenshot === null ? null : rows[0];
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * `solved_on` defaults to the app's today rather than the client's, for the
 * reason every date in this product does: the browser may be in another zone,
 * and a problem solved this evening must not file itself under tomorrow.
 */
export async function createProblem(input) {
  const { rows } = await query(
    `INSERT INTO leetcode_problems
       (number, title, difficulty, topics, url, solved_on, ai_assisted, approach, solution)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${DETAIL_COLUMNS}`,
    [
      input.number ?? null,
      input.title,
      input.difficulty,
      input.topics ?? [],
      input.url ?? null,
      input.solved_on ?? today(),
      input.ai_assisted ?? false,
      input.approach ?? null,
      input.solution ?? null,
    ],
  );
  return rows[0];
}

/**
 * Partial update, including the two state changes.
 *
 * `reviewed` and `archived` are booleans on the wire and dates in the table, so
 * they are handled apart from the column loop. Re-marking something already
 * reviewed keeps the original day rather than moving it — COALESCE, the same
 * way a task's completed_at holds still — because the answer to "when did I go
 * back over this" is the first time, not the last time a button was pressed.
 *
 * Marking it unreviewed writes NULL, which is the row rejoining the queue. That
 * is the whole of the undo: there is no third state to get stuck in.
 */
export async function updateProblem(id, patch, { reviewed, archived } = {}) {
  const sets = [];
  const params = [id];

  for (const column of PATCHABLE) {
    if (!Object.hasOwn(patch, column)) continue;
    sets.push(`${column} = $${params.push(patch[column])}`);
  }

  if (reviewed !== undefined) {
    sets.push(
      reviewed
        ? `reviewed_on = COALESCE(reviewed_on, $${params.push(today())})`
        : "reviewed_on = NULL",
    );
  }

  if (archived !== undefined) {
    sets.push(archived ? "archived_at = COALESCE(archived_at, now())" : "archived_at = NULL");
  }

  // The controller's schema already refuses an empty body, so this is a guard
  // rather than a reachable path — an UPDATE with no SET is a syntax error,
  // which would surface as a 500 for a mistake that is plainly a 400.
  if (sets.length === 0) throw badRequest("Nothing to update");

  const { rows } = await query(
    `UPDATE leetcode_problems SET ${sets.join(", ")}
      WHERE id = $1
      RETURNING ${DETAIL_COLUMNS}`,
    params,
  );

  if (rows.length === 0) throw notFound("No such problem");
  return rows[0];
}

/**
 * Stores the screenshot, replacing whatever was there.
 *
 * The declared type is checked against the bytes before anything is written:
 * this column is echoed into a Content-Type header, and a header the app took
 * on trust is how an <img> tag ends up serving something that is not an image.
 * A mismatch is answered rather than quietly corrected to whatever the bytes
 * really are — silently storing something other than what was sent is how a
 * screenshot turns out to be a different file six months later.
 */
export async function setScreenshot(id, buffer, declaredType) {
  if (!IMAGE_TYPES.includes(declaredType)) {
    throw badRequest("A screenshot must be a PNG, JPEG or WebP image");
  }
  if (buffer.length === 0) throw badRequest("That screenshot was empty");

  const actual = sniff(buffer);
  if (actual === null) throw badRequest("That file is not a PNG, JPEG or WebP image");
  if (actual !== declaredType) {
    throw badRequest(`That file is a ${actual}, but it arrived labelled ${declaredType}`);
  }

  const { rows } = await query(
    `UPDATE leetcode_problems
        SET screenshot = $2, screenshot_type = $3, screenshot_bytes = $4
      WHERE id = $1
      RETURNING ${DETAIL_COLUMNS}`,
    [id, buffer, declaredType, buffer.length],
  );

  if (rows.length === 0) throw notFound("No such problem");
  return rows[0];
}

/**
 * Deletes a problem, but only one that has nothing on it worth keeping.
 *
 * The rule habits already use, applied to the thing this table records: you can
 * delete a mistake, you must archive a record. A row carrying an approach, a
 * solution or a screenshot is a record — those are the three things you cannot
 * get back by re-reading LeetCode — and it can only be archived. A row that is
 * a title, a number and a difficulty is a mistyped entry, and hiding one in the
 * recovery list for ever is not a correction.
 *
 * One statement rather than a check and then a delete, following deleteHabit:
 * the guard and the delete share a snapshot, so a note written between the two
 * cannot be destroyed by a delete that was authorised before it existed.
 */
export async function deleteProblem(id) {
  const { rows } = await query(
    `WITH victim AS (
       DELETE FROM leetcode_problems
        WHERE id = $1
          AND approach IS NULL AND solution IS NULL AND screenshot IS NULL
       RETURNING id
     )
     SELECT EXISTS (SELECT 1 FROM victim) AS deleted,
            EXISTS (SELECT 1 FROM leetcode_problems WHERE id = $1) AS existed`,
    [id],
  );

  const { deleted, existed } = rows[0];
  if (deleted) return;
  if (!existed) throw notFound("No such problem");
  throw conflict(
    "This problem has notes or a screenshot on it. Archive it instead of deleting it.",
  );
}

/** Idempotent: clearing a screenshot that was never there is the same outcome. */
export async function clearScreenshot(id) {
  const { rows } = await query(
    `UPDATE leetcode_problems
        SET screenshot = NULL, screenshot_type = NULL, screenshot_bytes = NULL
      WHERE id = $1
      RETURNING id`,
    [id],
  );
  if (rows.length === 0) throw notFound("No such problem");
}

/**
 * How many solves fall in a date range.
 *
 * Archived rows are counted: archiving tidies the working list, it does not
 * unmake the fact that the problem was solved that month, and a comparison that
 * quietly dropped them would report a month emptying out over time.
 */
export async function countSolvedBetween(from, to) {
  const { rows } = await query(
    "SELECT count(*)::int AS solved FROM leetcode_problems WHERE solved_on BETWEEN $1 AND $2",
    [from, to],
  );
  return rows[0].solved;
}
