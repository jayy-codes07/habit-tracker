import { request, sendJson } from "../../lib/api-client";
import type { Id, IsoDate, Task } from "../../types";

/** Tasks are archived, never deleted — hence `archived` rather than a DELETE. */
export interface TaskPatch {
  title?: string;
  due_date?: IsoDate | null;
  completed?: boolean;
  archived?: boolean;
}

/** Which view of the table to read. The three are mutually exclusive. */
export type TaskScope = "open" | "all" | "archived";

/**
 * "open" is what is still to do, "all" adds the completed ones, and "archived"
 * is the mirror: only removed tasks, most recently removed first. That last one
 * is the recovery path — nothing else hands back the id of a removed task.
 */
export const getTasks = (scope: TaskScope = "open") =>
  request<{ tasks: Task[] }>(`/tasks${scope === "open" ? "" : `?scope=${scope}`}`);

export const createTask = (title: string, due_date: IsoDate | null) =>
  sendJson<{ task: Task }>("POST", "/tasks", { title, due_date });

export const patchTask = (id: Id, patch: TaskPatch) =>
  sendJson<{ task: Task }>("PATCH", `/tasks/${id}`, patch);
