import { useMutation, useQueryClient } from "@tanstack/react-query";

import * as api from "./api";
import { invalidateAll } from "../../lib/invalidate";
import type { Id, IsoDate } from "../../types";

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
