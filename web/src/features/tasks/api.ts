import { sendJson } from "../../lib/api-client";
import type { Id, IsoDate, Task } from "../../types";

/** Tasks are archived, never deleted — hence `archived` rather than a DELETE. */
export interface TaskPatch {
  title?: string;
  due_date?: IsoDate | null;
  completed?: boolean;
  archived?: boolean;
}

export const createTask = (title: string, due_date: IsoDate | null) =>
  sendJson<{ task: Task }>("POST", "/tasks", { title, due_date });

export const patchTask = (id: Id, patch: TaskPatch) =>
  sendJson<{ task: Task }>("PATCH", `/tasks/${id}`, patch);
