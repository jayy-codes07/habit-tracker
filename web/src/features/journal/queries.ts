import { useMutation, useQueryClient } from "@tanstack/react-query";

import * as api from "./api";
import type { IsoDate } from "../../types";

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
