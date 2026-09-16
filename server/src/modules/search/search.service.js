/**
 * One search across everything that was written down.
 *
 * The product records what happened; this is how you find it again. Four
 * sources, one ordering — newest first, interleaved — because "when did I write
 * about the knee" is a question about a date and not about which table the
 * sentence landed in.
 *
 * ILIKE, deliberately, and it is the right tool at this scale rather than a
 * corner cut. This is one person's record: a few thousand journal lines, a few
 * thousand notes, a few hundred problems. A sequential scan of that is a
 * handful of milliseconds, it matches substrings — "knee" finds "kneeling",
 * which a stemmed tsquery does not — and it needs no index, no trigger, no
 * generated column and no second copy of every sentence to keep in step.
 *
 * ponytail: full scan per source. Add pg_trgm GIN indexes on journal.entry,
 * habit_logs.note and the three leetcode text columns when the record passes
 * ~100k rows; the query above does not have to change for that to help.
 */
import { query } from "../../db/index.js";

/**
 * Where the snippet is cut, either side of the match.
 *
 * Wide enough that a sentence keeps its subject, narrow enough that a 40,000
 * character solution contributes one line to a list and not a screen.
 */
const RADIUS = 60;

/**
 * The needle as a LIKE pattern.
 *
 * The escaping is load-bearing rather than tidy: '%' and '_' are wildcards, so
 * an unescaped search for "100%" matches every row in the table, and a search
 * for "a_b" quietly matches "axb". Backslash is Postgres's default LIKE escape
 * character, which is why it has to be escaped first.
 */
const pattern = (needle) => `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/**
 * The matching fragment of `text`, or null when it does not match.
 *
 * Whitespace is collapsed before the cut: a solution is indented code and a
 * journal entry has paragraphs, and a list row is one line whatever the source
 * looked like. The ellipses say the fragment was cut, so nothing pretends to be
 * the whole entry.
 */
function snippet(text, needle) {
  if (!text) return null;

  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(needle);
  if (at === -1) return null;

  const from = Math.max(0, at - RADIUS);
  const to = Math.min(flat.length, at + needle.length + RADIUS);

  return `${from > 0 ? "…" : ""}${flat.slice(from, to)}${to < flat.length ? "…" : ""}`;
}

/**
 * Searches every written thing, newest first.
 *
 * Each source is asked for its own newest `limit + 1` matches and the merged
 * list is cut to `limit`. The cut is exact rather than approximate: the newest
 * N of a union is always a subset of the union of each source's newest N.
 *
 * The spare row is what makes `truncated` honest. At exactly `limit` per source
 * a full page and a page with a thousand more behind it are indistinguishable,
 * so the flag read false precisely when it mattered — and the alternative is a
 * COUNT over every source to answer a question worth one extra row.
 *
 * Four statements rather than one UNION ALL. They return different columns and
 * need different snippet rules, and a single query would have to flatten all of
 * that into a CASE ladder that is harder to read than the four queries it
 * replaces — for one round trip on a local socket.
 */
export async function search(text, { limit = 50 } = {}) {
  const needle = text.trim().toLowerCase();
  const like = pattern(needle);
  // One more than asked for, per source — see the note above.
  const reach = limit + 1;

  const [journal, notes, problems] = await Promise.all([
    query(
      `SELECT date, kind, entry
         FROM journal
        WHERE entry ILIKE $1
        ORDER BY date DESC
        LIMIT $2`,
      [like, reach],
    ),
    query(
      `SELECT l.date, l.note, l.habit_id, h.name
         FROM habit_logs l
         JOIN habits h ON h.id = l.habit_id
        WHERE l.note ILIKE $1
        ORDER BY l.date DESC
        LIMIT $2`,
      [like, reach],
    ),
    // Archived problems are searched too. They are archived, not deleted — the
    // record is exactly what this endpoint exists to reach — and /leetcode/:id
    // opens one, so the result has somewhere to go. The row says so instead.
    query(
      `SELECT id, title, solved_on, topics, approach, solution, archived_at
         FROM leetcode_problems
        WHERE title ILIKE $1
           OR approach ILIKE $1
           OR solution ILIKE $1
           OR EXISTS (SELECT 1 FROM unnest(topics) AS topic WHERE topic ILIKE $1)
        ORDER BY solved_on DESC
        LIMIT $2`,
      [like, reach],
    ),
  ]);

  const results = [
    ...journal.rows.map((row) => ({
      // A monthly reflection and a day entry share a table and are two
      // different screens, so they are two kinds here.
      kind: row.kind === "month" ? "reflection" : "journal",
      id: null,
      date: row.date,
      title: null,
      snippet: snippet(row.entry, needle),
    })),
    ...notes.rows.map((row) => ({
      kind: "note",
      // The habit, so a note can be opened at its habit as well as at its day.
      id: row.habit_id,
      date: row.date,
      title: row.name,
      snippet: snippet(row.note, needle),
    })),
    ...problems.rows.map((row) => ({
      kind: "problem",
      id: row.id,
      date: row.solved_on,
      title: row.title,
      /*
       * The first field that actually matched, in the order someone would want
       * to read: what it was about, then how I solved it, then the code. A
       * title-only match has no fragment to show — the title above IS the
       * match — and the topics stand in for one when the tag is what matched.
       */
      snippet:
        snippet(row.approach, needle) ??
        snippet(row.solution, needle) ??
        (row.topics.some((topic) => topic.toLowerCase().includes(needle))
          ? row.topics.join(", ")
          : null),
      archived: row.archived_at !== null,
    })),
  ].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));

  return { results: results.slice(0, limit), truncated: results.length > limit };
}
