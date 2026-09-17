import { useMutation, useQueryClient } from "@tanstack/react-query";

import * as api from "./api";
import { invalidateRecord } from "../../lib/invalidate";
import type { IsoDate, IsoMonth } from "../../types";

export function useSaveJournal(date: IsoDate) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (entry: string) =>
      entry.trim() ? api.saveJournal(date, entry.trim()) : api.deleteJournal(date),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["day", date] });
      void client.invalidateQueries({ queryKey: ["review"] });
      // An entry is the largest thing Find searches, and a written day is a
      // count in the year-on-year comparison. Every other feature's writes say
      // so; this one silently did not, so a note saved on the Day screen was
      // invisible to a search whose results were already cached.
      invalidateRecord(client);
    },
  });
}

/** As above: an emptied box means delete, because a blank entry cannot be stored. */
export function useSaveMonthJournal(month: IsoMonth) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (entry: string) =>
      entry.trim() ? api.saveMonthJournal(month, entry.trim()) : api.deleteMonthJournal(month),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["review"] });
      invalidateRecord(client);
    },
  });
}
