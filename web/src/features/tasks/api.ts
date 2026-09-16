import { request, sendJson } from "../../lib/api-client";
import type { ClockTime, Id, IsoDate, Task, TasksPayload } from "../../types";

/** Tasks are archived, never deleted — hence `archived` rather than a DELETE. */
export interface TaskPatch {
  title?: string;
  due_date?: IsoDate | null;
  completed?: boolean;
  archived?: boolean;
  /**
   * Null turns the reminder off; omitting it leaves it alone. Clearing the due
   * date clears this too, server-side and in the same statement — an undated
   * task belongs to no day, so there is no day for a reminder to be on.
   */
  reminder_at?: ClockTime | null;
}

/** Which view of the table to read. The three are mutually exclusive. */
export type TaskScope = "open" | "all" | "archived";

/**
 * "open" is what is still to do, "all" adds the completed ones, and "archived"
 * is the mirror: only removed tasks, most recently removed first. That last one
 * is the recovery path — nothing else hands back the id of a removed task.
 *
 * The payload carries `today` in APP_TIMEZONE, exactly as /day and /grid do, and
 * it is the only thing allowed to decide whether a due date has passed.
 */
export const getTasks = (scope: TaskScope = "open") =>
  request<TasksPayload>(`/tasks${scope === "open" ? "" : `?scope=${scope}`}`);

export const createTask = (title: string, due_date: IsoDate | null) =>
  sendJson<{ task: Task }>("POST", "/tasks", { title, due_date });

export const patchTask = (id: Id, patch: TaskPatch) =>
  sendJson<{ task: Task }>("PATCH", `/tasks/${id}`, patch);
