/**
 * What a result is, and where it goes.
 *
 * Kept out of the component for the reason verdict.ts and problems.ts are:
 * `react-refresh/only-export-components` forbids a .tsx from exporting plain
 * functions, and these two are the search screen's whole domain logic.
 */
import { monthOf } from "../../lib/dates";
import type { SearchKind, SearchResult } from "../../types";

/**
 * The screen a result opens.
 *
 * The routes live here rather than on the payload: the server owns the record
 * and this app owns its URLs, and a href baked into a response is a route that
 * cannot be renamed without a redeploy.
 *
 * A note goes to its DAY, not to its habit. The note is editable there and
 * nowhere else, and "take me to what I found" has to mean the thing itself —
 * the habit's whole history is one tap further on, from the day's own sheet.
 */
export function hrefOf(result: SearchResult): string {
  switch (result.kind) {
    case "journal":
    case "note":
      return `/day/${result.date}`;
    // A reflection is anchored to the 1st of its month, and /review is the only
    // screen that can show one.
    case "reflection":
      return `/review/${monthOf(result.date)}`;
    case "problem":
      return `/leetcode/${result.id}`;
  }
}

/** What the result is, in the interface's own voice. */
export const KIND_LABEL: Record<SearchKind, string> = {
  journal: "Day entry",
  reflection: "Reflection",
  note: "Habit note",
  problem: "Problem",
};

/**
 * A snippet split into the parts that matched and the parts that did not, so
 * the caller can mark the first without putting user text through
 * dangerouslySetInnerHTML.
 *
 * The needle is escaped before it becomes a RegExp. That is not decoration:
 * searching for "c++" or "a(b" would otherwise throw a SyntaxError and blank
 * the results list for a query the server answered perfectly well.
 *
 * Alternating pieces, starting with an unmatched one — the split of a string on
 * a capturing group always does, even when the string begins with a match, in
 * which case the first piece is empty. So the caller marks every odd index.
 */
export function splitMatch(text: string, query: string): string[] {
  const needle = query.trim();
  if (needle === "") return [text];

  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.split(new RegExp(`(${escaped})`, "gi"));
}
