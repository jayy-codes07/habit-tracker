import { send, sendJson } from "../../lib/api-client";
import type { IsoDate, JournalEntry } from "../../types";

export const saveJournal = (date: IsoDate, entry: string) =>
  sendJson<{ entry: JournalEntry }>("PUT", `/journal/day/${date}`, { entry });

export const deleteJournal = (date: IsoDate) => send("DELETE", `/journal/day/${date}`);
