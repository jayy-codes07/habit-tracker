import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as api from "./api";

/**
 * The settings row, on its own key.
 *
 * It is not in invalidate.ts's DERIVED list and should not be: nothing else in
 * the app changes it, and it changes nothing else — a habit's reminder time
 * lives on the habit and rides the ["habits"] invalidation like every other
 * field of it.
 */
export const useReminderSettings = () =>
  useQuery({
    queryKey: ["reminders"],
    queryFn: api.getReminderSettings,
  });

export function usePatchReminderSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.patchReminderSettings,
    /*
     * The response is the whole settings row, so the cache can simply be told
     * rather than asked again — every control on the screen is driven by it and
     * a refetch round trip is a visible flicker on a checkbox. Only `settings`
     * is replaced: the VAPID key beside it is a fact about the deployment, not
     * about the row, and PATCH does not report it.
     */
    onSuccess: (payload) =>
      client.setQueryData(["reminders"], (previous) =>
        previous ? { ...previous, settings: payload.settings } : previous,
      ),
  });
}
