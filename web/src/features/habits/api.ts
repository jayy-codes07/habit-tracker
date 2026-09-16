/**
 * Habits — and their schedule versions and logs, which have no life of their
 * own and are reached only through a habit. Grouped as server/src/modules/habits
 * groups them.
 */
import { send, sendJson, request } from "../../lib/api-client";
import type {
  ClockTime,
  Habit,
  HistoryPayload,
  Id,
  IsoDate,
  LogStatus,
  Schedule,
  ScheduleInput,
} from "../../types";

export const getHabits = (includeArchived = false) =>
  request<{ habits: Habit[] }>(`/habits${includeArchived ? "?include=archived" : ""}`);

export const createHabit = (body: {
  name: string;
  color_token: string;
  start_date?: IsoDate;
  /** Omit for a binary habit; a non-blank unit is what makes it a measured one. */
  unit?: string | null;
  schedule: ScheduleInput;
}) => sendJson<{ habit: Habit }>("POST", "/habits", body);

/**
 * `unit` is deliberately absent unless it is being changed. The server patches
 * by key presence — an absent key leaves it alone, an explicit null clears it —
 * so a caller that always sent `unit` would turn every rename into a unit write,
 * and a unit write is refused outright once the habit has measured anything.
 */
export const patchHabit = (
  id: Id,
  patch: {
    name?: string;
    color_token?: string;
    archived?: boolean;
    unit?: string | null;
    /** Null turns the reminder off; omitting it leaves it alone. */
    reminder_at?: ClockTime | null;
  },
) => sendJson<{ habit: Habit }>("PATCH", `/habits/${id}`, patch);

/**
 * Appends a schedule version. effective_from is deliberately not sent: the
 * server defaults it to today, backdating is refused, and a future-dated
 * version would vanish from GET /habits on the next refetch — which resolves
 * the schedule as of today — making a successful save look like a failure.
 */
export const setSchedule = (id: Id, schedule: ScheduleInput) =>
  sendJson<{ schedule: Schedule }>("POST", `/habits/${id}/schedule`, schedule);

/**
 * One habit's whole life, with its written days a page at a time.
 *
 * `before` is a date cursor rather than a page number: habit_logs is unique on
 * (habit_id, date), so paging backwards through it is free, and a page stays
 * stable while the history behind it is being edited.
 */
export const getHistory = (id: Id, before?: IsoDate) =>
  request<HistoryPayload>(`/habits/${id}/history${before ? `?before=${before}` : ""}`);

// --- logs -----------------------------------------------------------------

/**
 * PUT replaces, so anything left out is cleared. `undefined` therefore means
 * "do not send this field" and null means "clear it" — the two are not the same
 * and the caller has to keep them apart. See useSetLog, which carries the note
 * and the value forward for a caller that mentioned neither.
 */
export const setLog = (
  habitId: Id,
  date: IsoDate,
  status: LogStatus,
  note?: string | null,
  value?: number | null,
) =>
  sendJson<{
    log: {
      habit_id: Id;
      date: IsoDate;
      status: LogStatus;
      value: number | null;
      note: string | null;
    };
  }>("PUT", `/habits/${habitId}/logs/${date}`, {
    status,
    ...(note === undefined ? {} : { note }),
    ...(value === undefined ? {} : { value }),
  });

export const clearLog = (habitId: Id, date: IsoDate) =>
  send("DELETE", `/habits/${habitId}/logs/${date}`);

/**
 * Rewrites display order. The server rejects anything that is not every active
 * habit exactly once, so this always sends the whole active list — archived
 * habits have no place in the order and must not appear here.
 */
export const reorderHabits = (ids: Id[]) =>
  sendJson<{ habits: Habit[] }>("PUT", "/habits/order", { ids });

/** 204, or 409 when the habit has logged history — archive that one instead. */
export const deleteHabit = (id: Id) => send("DELETE", `/habits/${id}`);
