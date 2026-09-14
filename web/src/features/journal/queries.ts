import { useMutation, useQueryClient } from "@tanstack/react-query";

import * as api from "./api";
import type { IsoDate, IsoMonth } from "../../types";

export function useSaveJournal(date: IsoDate) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (entry: string) =>
      entry.trim() ? api.saveJournal(date, entry.trim()) : api.deleteJournal(date),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["day", date] });
      void client.invalidateQueries({ queryKey: ["review"] });
    },
  });
}

/** As above: an emptied box means delete, because a blank entry cannot be stored. */
export function useSaveMonthJournal(month: IsoMonth) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (entry: string) =>
      entry.trim() ? api.saveMonthJournal(month, entry.trim()) : api.deleteMonthJournal(month),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["review"] }),
  });
}
