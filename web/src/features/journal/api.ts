import { send, sendJson } from "../../lib/api-client";
import type { IsoDate, IsoMonth, JournalEntry } from "../../types";

export const saveJournal = (date: IsoDate, entry: string) =>
  sendJson<{ entry: JournalEntry }>("PUT", `/journal/day/${date}`, { entry });

export const deleteJournal = (date: IsoDate) => send("DELETE", `/journal/day/${date}`);

/**
 * The monthly reflection. A separate pair of endpoints rather than a ?kind=,
 * because a day note and a reflection can both exist on the 1st.
 */
export const saveMonthJournal = (month: IsoMonth, entry: string) =>
  sendJson<{ entry: JournalEntry }>("PUT", `/journal/month/${month}`, { entry });

export const deleteMonthJournal = (month: IsoMonth) => send("DELETE", `/journal/month/${month}`);
