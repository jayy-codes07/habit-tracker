/**
 * Habit routes.
 *
 * Validation is `schema.parse(...)` inline and nothing else: Express 5 forwards
 * a rejected async handler to the error middleware on its own, and the handler
 * already renders a ZodError as a 400 carrying only the path and message. That
 * is why there is no validate() middleware and no asyncHandler here.
 */
import { z } from "zod";

import { today } from "../../lib/dates.js";
import { idParam, isoDate } from "../../lib/schemas.js";
import { resolveSchedule } from "../../lib/scheduling.js";
import * as habits from "./habits.service.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const weekday = z.number().int().min(1).max(7);

/**
 * Mirrors the habit_schedules_shape CHECK constraint: fixed needs days and no
 * target, weekly needs a target and no days, paused needs neither. The database
 * is still the authority — this exists so a bad shape comes back as a readable
 * 400 rather than a constraint violation.
 */
const scheduleBody = z.discriminatedUnion("schedule_kind", [
  z.object({
    schedule_kind: z.literal("fixed"),
    schedule_days: z
      .array(weekday)
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, "weekdays must be distinct"),
  }),
  z.object({
    schedule_kind: z.literal("weekly"),
    weekly_target: z.number().int().min(1).max(7),
  }),
  z.object({ schedule_kind: z.literal("paused") }),
]);

const colorToken = z.enum(["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"]);
const habitName = z.string().trim().min(1).max(80);

const createBody = z.object({
  name: habitName,
  color_token: colorToken,
  start_date: isoDate.optional(),
  schedule: scheduleBody,
});

const updateBody = z
  .object({
    name: habitName.optional(),
    color_token: colorToken.optional(),
    archived: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "nothing to update");

const scheduleChangeBody = z.intersection(
  scheduleBody,
  z.object({ effective_from: isoDate.optional() }),
);

const logBody = z.object({
  status: z.enum(["done", "missed", "skipped"]),
  note: z.string().max(1000).nullish(),
});

const listQuery = z.object({ include: z.enum(["archived"]).optional() });

/** Normalises the validated schedule body into what the service stores. */
const toSchedule = (body) => ({
  kind: body.schedule_kind,
  days: body.schedule_days ?? null,
  weeklyTarget: body.weekly_target ?? null,
});

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * Ids are strings the whole way through. habits.id is bigint, and node-postgres
 * returns bigint as a string because there is no type-parser override for it —
 * only for DATE. Coercing to a number here would be lossy above 2^53 and would
 * buy nothing.
 */
function present(habit, versions, on) {
  const schedule = resolveSchedule(versions ?? [], habit.start_date, on);

  return {
    id: habit.id,
    name: habit.name,
    color_token: habit.color_token,
    sort_order: habit.sort_order,
    start_date: habit.start_date,
    archived_on: habit.archived_on,
    schedule: schedule
      ? {
          effective_from: schedule.effective_from,
          schedule_kind: schedule.schedule_kind,
          schedule_days: schedule.schedule_days,
          weekly_target: schedule.weekly_target,
        }
      : null,
  };
}

async function presentAll(rows) {
  const versions = await habits.loadVersions(rows.map((row) => row.id));
  const on = today();
  return rows.map((row) => present(row, versions.get(row.id), on));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function list(req, res) {
  const { include } = listQuery.parse(req.query);
  const rows = await habits.loadHabits({ includeArchived: include === "archived" });
  res.json({ habits: await presentAll(rows) });
}

export async function create(req, res) {
  const body = createBody.parse(req.body);

  const habit = await habits.createHabit({
    name: body.name,
    colorToken: body.color_token,
    // A habit with no start date starts now; backdating one is allowed so a
    // habit already under way can be entered with its history intact.
    startDate: body.start_date ?? today(),
    schedule: toSchedule(body.schedule),
  });

  res.status(201).json({ habit: (await presentAll([habit]))[0] });
}

export async function update(req, res) {
  const id = idParam.parse(req.params.id);
  const body = updateBody.parse(req.body);

  const habit = await habits.updateHabit(id, {
    name: body.name,
    colorToken: body.color_token,
    archived: body.archived,
  });

  res.json({ habit: (await presentAll([habit]))[0] });
}

export async function remove(req, res) {
  await habits.deleteHabit(idParam.parse(req.params.id));
  res.status(204).end();
}

export async function reorder(req, res) {
  const { ids } = z.object({ ids: z.array(idParam).min(1) }).parse(req.body);
  res.json({ habits: await presentAll(await habits.reorderHabits(ids)) });
}

export async function changeSchedule(req, res) {
  const id = idParam.parse(req.params.id);
  const body = scheduleChangeBody.parse(req.body);

  // Defaults to now, which is the common case: "from today, this is the plan".
  const schedule = await habits.setSchedule(id, body.effective_from ?? today(), toSchedule(body));

  res.status(201).json({ schedule });
}

export async function setLog(req, res) {
  const id = idParam.parse(req.params.id);
  const date = isoDate.parse(req.params.date);
  const body = logBody.parse(req.body);

  res.json({ log: await habits.setLog(id, date, { status: body.status, note: body.note }) });
}

export async function clearLog(req, res) {
  await habits.clearLog(idParam.parse(req.params.id), isoDate.parse(req.params.date));
  res.status(204).end();
}
