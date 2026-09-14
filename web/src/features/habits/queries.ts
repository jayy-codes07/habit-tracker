/**
 * Habit reads and writes, logs included.
 *
 * Only the log toggle is optimistic, because it is the only place latency is
 * felt — everything else happens behind a dialog that is already closing.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as api from "./api";
import { invalidateAll, invalidateScored } from "../../lib/invalidate";
import type {
  DayHabit,
  DayPayload,
  Habit,
  Id,
  IsoDate,
  LogStatus,
  ScheduleInput,
} from "../../types";

export const useHabits = (includeArchived = false) =>
  useQuery({
    queryKey: ["habits", includeArchived],
    queryFn: () => api.getHabits(includeArchived),
    select: (data) => data.habits,
  });

export function useCreateHabit() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createHabit,
    onSuccess: () => invalidateAll(client),
  });
}

export function usePatchHabit() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: Id;
      patch: { name?: string; color_token?: string; archived?: boolean };
    }) => api.patchHabit(id, patch),
    onSuccess: () => invalidateAll(client),
  });
}

export function useSetSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, schedule }: { id: Id; schedule: ScheduleInput }) =>
      api.setSchedule(id, schedule),
    onSuccess: () => invalidateAll(client),
  });
}

/**
 * Reordering is the one habit write that is optimistic, for the same reason the
 * log toggle is: it happens in the list itself, one tap at a time, and a row
 * that waits for a round trip before it moves invites a second tap on the
 * arrow — which would then race the first.
 *
 * `includeArchived` is the key of the list being reordered, so the screen that
 * shows archived habits patches the cache it is actually reading.
 */
export function useReorderHabits(includeArchived = false) {
  const client = useQueryClient();
  const key = ["habits", includeArchived];

  return useMutation({
    mutationFn: api.reorderHabits,

    onMutate: async (ids: Id[]) => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<{ habits: Habit[] }>(key);
      const position = new Map(ids.map((id, index) => [id, index]));

      // Archived habits are not in the order and are listed separately, so
      // where they land in this array does not matter.
      client.setQueryData<{ habits: Habit[] }>(key, (old) =>
        old
          ? {
              habits: [...old.habits].sort(
                (a, b) => (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity),
              ),
            }
          : old,
      );

      return { previous };
    },

    onError: (_error, _ids, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },

    onSettled: () => invalidateAll(client),
  });
}

/** 409 when the habit has logged history; the screen offers archiving instead. */
export function useDeleteHabit() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.deleteHabit,
    onSuccess: () => invalidateAll(client),
  });
}

// --- logs -----------------------------------------------------------------

export interface LogChange {
  habit: DayHabit;
  /** null clears the log entirely — back to never logged, which is its own state. */
  status: LogStatus | null;
  note?: string | null;
}

/**
 * A log is a habit write, but the cache it patches is the day payload — which
 * is the one place the two features touch, and why this takes the date.
 */
export function useSetLog(date: IsoDate) {
  const client = useQueryClient();
  const key = ["day", date];

  return useMutation({
    mutationFn: ({ habit, status, note }: LogChange) =>
      status === null
        ? api.clearLog(habit.id, date)
        : api.setLog(habit.id, date, status, note ?? habit.note),

    onMutate: async ({ habit, status, note }) => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<DayPayload>(key);

      // Only `status` and `note` are patched. `verdict` and `streak` cannot be
      // computed honestly here — a streak needs history the client does not
      // have, and a paused day is indistinguishable from an unscheduled one in
      // this payload. They correct themselves on settle; the row's appearance
      // is driven by `status` so nothing waits on them.
      client.setQueryData<DayPayload>(key, (old) =>
        old
          ? {
              ...old,
              habits: old.habits.map((row) =>
                row.id === habit.id
                  ? {
                      ...row,
                      status,
                      note: status === null ? null : (note ?? row.note),
                    }
                  : row,
              ),
            }
          : old,
      );

      return { previous };
    },

    onError: (_error, _change, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },

    onSettled: () => invalidateScored(client),
  });
}
