/**
 * Habits — and their schedule versions and logs, which have no life of their
 * own and are reached only through a habit. Grouped as server/src/modules/habits
 * groups them.
 */
import { send, sendJson, request } from "../../lib/api-client";
import type { Habit, Id, IsoDate, LogStatus, Schedule, ScheduleInput } from "../../types";

export const getHabits = (includeArchived = false) =>
  request<{ habits: Habit[] }>(`/habits${includeArchived ? "?include=archived" : ""}`);

export const createHabit = (body: {
  name: string;
  color_token: string;
  start_date?: IsoDate;
  schedule: ScheduleInput;
}) => sendJson<{ habit: Habit }>("POST", "/habits", body);

export const patchHabit = (
  id: Id,
  patch: { name?: string; color_token?: string; archived?: boolean },
) => sendJson<{ habit: Habit }>("PATCH", `/habits/${id}`, patch);

/**
 * Appends a schedule version. effective_from is deliberately not sent: the
 * server defaults it to today, backdating is refused, and a future-dated
 * version would vanish from GET /habits on the next refetch — which resolves
 * the schedule as of today — making a successful save look like a failure.
 */
export const setSchedule = (id: Id, schedule: ScheduleInput) =>
  sendJson<{ schedule: Schedule }>("POST", `/habits/${id}/schedule`, schedule);

// --- logs -----------------------------------------------------------------

export const setLog = (habitId: Id, date: IsoDate, status: LogStatus, note?: string | null) =>
  sendJson<{ log: { habit_id: Id; date: IsoDate; status: LogStatus; note: string | null } }>(
    "PUT",
    `/habits/${habitId}/logs/${date}`,
    { status, ...(note === undefined ? {} : { note }) },
  );

export const clearLog = (habitId: Id, date: IsoDate) =>
  send("DELETE", `/habits/${habitId}/logs/${date}`);
