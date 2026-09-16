/**
 * What the workspace derives, and the one rule it derives everything from.
 *
 * Kept out of the components for the reason colors.ts and verdict.ts are:
 * `react-refresh/only-export-components` forbids a .tsx from exporting a plain
 * function, and a rule this load-bearing should have one implementation anyway.
 */
import { useEffect } from "react";

import type { Difficulty, Problem } from "../../types";

/**
 * THE rule. A problem needs reviewing when I said I had help and have not been
 * back to it.
 *
 * This is the only place it is expressed. There is no `review_status` on the
 * payload and none should be added: a stored status can disagree with the two
 * facts behind it — set `ai_assisted` false and a row still claiming
 * "needs_review" is a lie the schema would permit — while two facts cannot
 * contradict themselves.
 *
 * Archived rows are excluded because they are not in the working list at all;
 * the caller passes the active scope, and this guards against the mistake of
 * counting a queue over the archived one.
 */
export const needsReview = (problem: Problem) =>
  problem.ai_assisted && problem.reviewed_on === null && problem.archived_at === null;

/**
 * Free-text search over everything a person would type to find a problem again
 * months later: its number, its name, and what it was about.
 *
 * Deliberately not over `approach` or `solution` — the list does not carry them
 * (see the Problem type), so a search that claimed to cover them would quietly
 * miss every match. Difficulty is not searched either; it has its own control,
 * and "hard" appearing in a title should not be outranked by a filter nobody
 * asked for.
 */
export function matches(problem: Problem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;

  return (
    problem.title.toLowerCase().includes(needle) ||
    problem.topics.some((topic) => topic.includes(needle)) ||
    // Bare digits match the number, so "146" finds #146 without a # and without
    // also matching every title containing 146 — which nothing does, but the
    // number is what someone typing digits means.
    (problem.number !== null && String(problem.number).includes(needle))
  );
}

/** Every tag in use, alphabetically — the datalist behind the topics field. */
export const topicVocabulary = (problems: Problem[]): string[] =>
  [...new Set(problems.flatMap((problem) => problem.topics))].sort();

/** The word, in the interface's own voice. Never a colour on its own. */
export const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

/**
 * Tags as typed, as tags.
 *
 * One comma-separated field rather than a tag-picker component: the server
 * lower-cases, trims and dedupes anyway, so the only thing left to do here is
 * drop the empty pieces a trailing comma leaves behind. Sending one would be a
 * 400 on a field the person has finished typing correctly.
 */
export const parseTopics = (value: string): string[] =>
  value
    .split(",")
    .map((topic) => topic.trim())
    .filter((topic) => topic !== "");

/** How many bytes, as something a person reads. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Ctrl+V anywhere on the screen, which is the gesture this feature is shaped
 * around: you screenshot the problem statement and paste it.
 *
 * It listens on the document rather than on a wrapper, and it has to. A paste
 * with no editable element focused targets `document.body`, and a React
 * `onPaste` on a div below body never sees an event that never travels down to
 * it — so the handler that reads most naturally is the one that silently never
 * fires.
 *
 * It only ever claims a paste that carries an image file. Pasting text into the
 * notes field is untouched, and pasting an image into a textarea was going to
 * insert nothing anyway.
 */
export function usePastedImage(onImage: (file: File) => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const handler = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((candidate) =>
        candidate.type.startsWith("image/"),
      );
      if (!file) return;
      event.preventDefault();
      onImage(file);
    };

    document.addEventListener("paste", handler);
    return () => document.removeEventListener("paste", handler);
  }, [onImage, enabled]);
}
