import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as api from "./api";
import { invalidateRecord } from "../../lib/invalidate";
import type { Id } from "../../types";

/**
 * Invalidation stops at ["leetcode"], and deliberately does not call
 * invalidateAll.
 *
 * invalidateAll exists because habit, task and journal writes all reach the same
 * derived reads — a log written last March changes today's streak, this month's
 * review and a grid cell a year back. Nothing here is derived from anything
 * there, and nothing there is derived from this: recording a problem does not
 * change a streak, and ticking a habit does not change the review queue.
 * Sweeping both directions would be a claim that they are connected, and a
 * refetch of six screens on every keystroke-saved note.
 *
 * The two exceptions are Find and the year-on-year comparison, which read the
 * whole record across every feature by definition — a problem's approach is
 * searchable text and a solve is a count in its month. invalidateRecord is
 * exactly those two, so this stays a narrow sweep rather than becoming
 * invalidateAll by increments.
 */
const invalidate = (client: ReturnType<typeof useQueryClient>) => {
  void client.invalidateQueries({ queryKey: ["leetcode"] });
  invalidateRecord(client);
};

/**
 * The whole scope in one read. Search, the difficulty filter and the review
 * queue are all computed from these rows in the component — a few hundred rows
 * held locally, filtered with Array.filter, is instant and cannot disagree with
 * itself the way a second server read could.
 */
export const useProblems = (scope: api.ProblemScope = "active") =>
  useQuery({
    queryKey: ["leetcode", scope],
    queryFn: () => api.getProblems(scope),
  });

/**
 * One problem, for its `approach` and `solution` — the two columns the list
 * does not carry. Enabled only when there is one selected, so the workspace
 * with nothing open makes one request rather than two.
 */
export const useProblem = (id: Id | null) =>
  useQuery({
    queryKey: ["leetcode", "problem", id],
    queryFn: () => api.getProblem(id as Id),
    enabled: id !== null,
  });

export function useCreateProblem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: api.ProblemInput) => api.createProblem(input),
    onSuccess: () => invalidate(client),
  });
}

export function usePatchProblem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: Id; patch: api.ProblemPatch }) => api.patchProblem(id, patch),
    onSuccess: () => invalidate(client),
  });
}

/**
 * The upload. On success the img element pointing at the same URL has to be
 * told to look again — the address never changes when a screenshot is replaced
 * — which the detail pane does by keying the plate on `updated_at` from the
 * refetched row. Hence the invalidation here rather than a cache patch.
 */
export function useSetScreenshot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: Id; file: File }) => api.putScreenshot(id, file),
    onSuccess: () => invalidate(client),
  });
}

export function useDeleteScreenshot() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: Id) => api.deleteScreenshot(id),
    onSuccess: () => invalidate(client),
  });
}
