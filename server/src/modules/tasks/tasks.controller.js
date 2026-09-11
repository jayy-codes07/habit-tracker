/**
 * Task routes.
 *
 * Removal is PATCH { archived: true }, not DELETE — see tasks.service.js. There
 * is deliberately no DELETE route: nothing a single tap does here is
 * irreversible.
 */
import { z } from "zod";

import { idParam, isoDate } from "../../lib/schemas.js";
import * as tasks from "./tasks.service.js";

const title = z.string().trim().min(1).max(200);

const createBody = z.object({
  title,
  due_date: isoDate.nullish(),
});

const updateBody = z
  .object({
    title: title.optional(),
    // Nullable on purpose: sending null clears the due date, which is different
    // from leaving the field out.
    due_date: isoDate.nullish(),
    completed: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "nothing to update");

const listQuery = z.object({ scope: z.enum(["open", "all"]).optional() });

export async function list(req, res) {
  const { scope } = listQuery.parse(req.query);
  res.json({ tasks: await tasks.loadTasks({ includeCompleted: scope === "all" }) });
}

export async function create(req, res) {
  const body = createBody.parse(req.body);
  const task = await tasks.createTask({ title: body.title, dueDate: body.due_date });
  res.status(201).json({ task });
}

export async function update(req, res) {
  const id = idParam.parse(req.params.id);
  const body = updateBody.parse(req.body);

  const task = await tasks.updateTask(id, {
    title: body.title,
    dueDate: body.due_date,
    // "Was due_date sent at all", which COALESCE alone cannot distinguish from
    // "was sent as null".
    dueDateGiven: Object.hasOwn(body, "due_date"),
    completed: body.completed,
    archived: body.archived,
  });

  res.json({ task });
}
