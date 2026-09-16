/**
 * Invalidation is deliberately blunt, and shared: streaks and consistency are
 * recomputed over a habit's whole history on every read, so a log written last
 * March can change today's streak, this month's review and a grid cell a year
 * back. Patching three payload shapes surgically would be a lot of code that is
 * wrong in ways nobody notices; prefix invalidation is free, because TanStack
 * only refetches queries that are actually mounted.
 *
 * It lives here rather than in one feature because every feature's mutations
 * reach the same derived reads.
 */
import type { QueryClient } from "@tanstack/react-query";

/** Everything derived from habit, task or journal rows. */
const DERIVED = ["day", "grid", "review", "history", "habits", "tasks"] as const;

/** The scored reads only — the ones a log can change. */
// "history" is here because a habit's page carries its spine and its notes,
// and a log written from the day screen changes both.
const SCORED = ["day", "grid", "review", "history"] as const;

export const invalidateAll = (client: QueryClient) => {
  for (const key of DERIVED) void client.invalidateQueries({ queryKey: [key] });
};

export const invalidateScored = (client: QueryClient) => {
  for (const key of SCORED) void client.invalidateQueries({ queryKey: [key] });
};
