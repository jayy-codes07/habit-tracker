import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as api from "./api";
import { invalidateAll } from "../../lib/invalidate";
import type { Id, IsoDate } from "../../types";

/**
 * `invalidateAll` already clears the ["tasks"] prefix, so every write refreshes
 * every scope — which is what makes removing and restoring update both the
 * working list and the removed list without either knowing about the other.
 *
 * The whole payload is handed back rather than selected down to `tasks`: it also
 * carries the server's `today`, and the screen needs both to group a list by
 * what is overdue.
 */
export const useTasks = (scope: api.TaskScope = "open") =>
  useQuery({
    queryKey: ["tasks", scope],
    queryFn: () => api.getTasks(scope),
  });

export function useCreateTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ title, due_date }: { title: string; due_date: IsoDate | null }) =>
      api.createTask(title, due_date),
    onSuccess: () => invalidateAll(client),
  });
}

export function usePatchTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: Id; patch: api.TaskPatch }) => api.patchTask(id, patch),
    onSuccess: () => invalidateAll(client),
  });
}
