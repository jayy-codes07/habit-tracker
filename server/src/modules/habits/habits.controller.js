/**
 * Habit routes.
 *
 * Validation is `schema.parse(...)` inline and nothing else: Express 5 forwards
 * a rejected async handler to the error middleware on its own, and the handler
 * already renders a ZodError as a 400 carrying only the path and message. That
 * is why there is no validate() middleware and no asyncHandler here.
 */
import { z } from "zod";

import { eachDay, endOfWeek, startOfWeek, today } from "../../lib/dates.js";
import { notFound } from "../../lib/errors.js";
import { idParam, isoDate } from "../../lib/schemas.js";
import {
  dayVerdict,
  resolveNextSchedule,
  resolveResumeSchedule,
  resolveSchedule,
  shapeSchedule,
  VERDICT_CHAR,
} from "../../lib/scheduling.js";
import * as habits from "./habits.service.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const weekday = z.number().int().min(1).max(7);

/**
 * The largest amount habit_logs.value and habit_schedules.target_value can hold.
 *
 * Checked here for the same reason idParam range-checks bigint: a number past
 * the column's precision reaches Postgres as a parameter and raises SQLSTATE
 * 22003, which carries no status and so becomes a logged 500 — for what is only
 * ever a mistyped quantity.
 */
const MAX_AMOUNT = 99_999_999.99;

/**
 * The smallest amount worth storing.
 *
 * numeric(10, 2) rounds on the way in, so 0.004 would be stored as 0.00 and a
 * positive measurement would silently become a zero one — which on a `done` log
 * is a constraint violation reported as a 500, and on any other is a quiet lie.
 * The true rounding boundary is 0.005 (Postgres rounds half away from zero), but
 * the floor is the storable precision rather than the rounding cliff: a value
 * between the two survives only by being rounded up, which is still not the
 * number anyone typed.
 */
const MIN_AMOUNT = 0.01;

const amount = z
  .number()
  .finite()
  .max(MAX_AMOUNT, `must be at most ${MAX_AMOUNT}`)
  .min(MIN_AMOUNT, `must be at least ${MIN_AMOUNT}`);

/**
 * A measured value. Zero is allowed here and rejected only on `done` below:
 * "I tried and got nowhere" is a real claim on a missed or skipped day, while
 * "I consider this done, and I did zero" has no reading at all.
 */
const measuredValue = z.union([z.literal(0), amount]);

/**
 * Mirrors the habit_schedules_shape CHECK constraint: fixed needs days and no
 * weekly target, weekly needs a weekly target and no days, paused needs neither
 * — and no amount either. The database is still the authority; this exists so a
 * bad shape comes back as a readable 400 rather than a constraint violation.
 *
 * `target_value` is the amount asked for on one occasion and is unrelated to
 * `weekly_target`, which counts occasions. Both may appear on a weekly version
 * and they answer different questions: three times a week, five kilometres each.
 */
const scheduleBody = z.discriminatedUnion("schedule_kind", [
  z.object({
    schedule_kind: z.literal("fixed"),
    schedule_days: z
      .array(weekday)
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, "weekdays must be distinct"),
    // Optional on purpose: a quantity habit may measure without aiming.
    target_value: amount.nullish(),
  }),
  z.object({
    schedule_kind: z.literal("weekly"),
    weekly_target: z.number().int().min(1).max(7),
    target_value: amount.nullish(),
  }),
  // No target, matching the shape CHECK: a pause asks for nothing, including
  // no amount. What the habit will resume to is recovered from the last version
  // that asked for something — see resolveResumeSchedule.
  z.object({ schedule_kind: z.literal("paused") }),
]);

const colorToken = z.enum(["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"]);
const habitName = z.string().trim().min(1).max(80);

/** Mirrors habits_unit_valid. NOT NULL here is what makes a habit quantity-based. */
const habitUnit = z.string().trim().min(1).max(20);

const createBody = z.object({
  name: habitName,
  color_token: colorToken,
  start_date: isoDate.optional(),
  unit: habitUnit.nullish(),
  schedule: scheduleBody,
});

const updateBody = z
  .object({
    name: habitName.optional(),
    color_token: colorToken.optional(),
    archived: z.boolean().optional(),
    // nullable, not merely optional: clearing the unit is a real request while
    // the habit has measured nothing, and is refused by the service afterwards.
    // Which of the two was meant is decided by key presence, not by the value.
    unit: habitUnit.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "nothing to update");

const scheduleChangeBody = z.intersection(
  scheduleBody,
  z.object({ effective_from: isoDate.optional() }),
);

const logBody = z
  .object({
    status: z.enum(["done", "missed", "skipped"]),
    value: measuredValue.nullish(),
    note: z.string().max(1000).nullish(),
  })
  // Mirrors habit_logs_done_value_not_zero. The database is the authority; this
  // exists so the one contradictory pair comes back as a readable 400 instead of
  // a constraint violation with no status, which the handler would log as a 500.
  .refine(
    (body) => !(body.status === "done" && body.value === 0),
    "a done log cannot record a value of zero — leave it blank if you did not measure",
  );

const listQuery = z.object({ include: z.enum(["archived"]).optional() });

/**
 * The history cursor. `before` is a date rather than a page number for the
 * reason loadNotes gives: a page has to stay stable while the history behind it
 * is being edited, and an offset does not.
 */
const historyQuery = z.object({
  before: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Normalises the validated schedule body into what the service stores. */
const toSchedule = (body) => ({
  kind: body.schedule_kind,
  days: body.schedule_days ?? null,
  weeklyTarget: body.weekly_target ?? null,
  targetValue: body.target_value ?? null,
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
  const history = versions ?? [];
  const schedule = resolveSchedule(history, habit.start_date, on);

  return {
    id: habit.id,
    name: habit.name,
    color_token: habit.color_token,
    sort_order: habit.sort_order,
    start_date: habit.start_date,
    archived_on: habit.archived_on,
    /*
     * The only marker that this habit is measured: NOT NULL means quantity.
     * Not the target, which is on the version and is absent while paused — a
     * paused quantity habit is still a quantity habit.
     */
    unit: habit.unit,
    /*
     * Whether the unit can still be changed. Reported because the client cannot
     * derive it: it would have to know whether any log in the habit's whole
     * history carries a value. The server refuses the change regardless — this
     * is so the interface can say so first rather than offer a field that will
     * be rejected.
     */
    unit_locked: habit.unit_locked,
    schedule: shapeSchedule(schedule),
    // Only meaningful while paused, and null otherwise: a habit that is not
    // paused resumes to nothing. Never paused itself — see resolveResumeSchedule.
    resumes_to:
      schedule?.schedule_kind === "paused"
        ? shapeSchedule(resolveResumeSchedule(history, habit.start_date, on))
        : null,
    /*
     * The change that has been decided but has not started. `schedule` above is
     * still the one in force today and is unaffected by it — this is reported
     * alongside, never instead, because the two say different things and the
     * interface has to be able to show both.
     *
     * Without it the only schedule a client ever sees is today's, so a version
     * the server dated forward (a switch between fixed and weekly waits for the
     * following Monday) vanished on the next refetch.
     */
    next_schedule: shapeSchedule(resolveNextSchedule(history, on)),
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

/**
 * One habit's whole life: its spine, its schedule versions, and what was
 * written on the days it was kept.
 *
 * It lives in this module rather than in overview/ because it composes nothing
 * but habits — no tasks, no journal — and the scoring rules it does use are the
 * pure ones in lib/, which is where they are kept in one place. overview/ earns
 * its existence by joining three services; this joins none.
 *
 * The spine runs whole Monday-to-Sunday weeks from the habit's start to the
 * last day it was alive for, so the client can index a cell by offset exactly
 * as it does on the grid, with the same nine-verdict encoding. Its tally is not
 * sent: the client already decodes these characters and counts them, and a
 * second implementation of the same arithmetic is a second thing to be wrong.
 *
 * No maxima are reported and none should be added. A count says what happened;
 * a "best" is a high score in a game with one player, and the moment a screen
 * carries one, deciding not to break a record becomes a reason not to rest.
 */
export async function history(req, res) {
  const id = idParam.parse(req.params.id);
  const { before, limit } = historyQuery.parse(req.query);

  const habit = await habits.loadHabit(id);
  if (!habit) throw notFound("No such habit");

  const on = today();
  const versions = (await habits.loadVersions([id])).get(id) ?? [];

  // An archived habit stops where it was archived. Painting the empty weeks
  // between then and today would say the habit had been failing since.
  const through = habit.archived_on && habit.archived_on < on ? habit.archived_on : on;
  const start = startOfWeek(habit.start_date);
  const end = endOfWeek(through);
  const days = eachDay(start, end);

  const logs = (await habits.loadLogs([id], start, end)).get(id) ?? new Map();
  const { notes, more } = await habits.loadNotes(id, { before, limit });

  res.json({
    habit: present(habit, versions, on),
    today: on,
    start,
    end,
    weeks: days.length / 7,
    cells: days
      .map(
        (date) =>
          VERDICT_CHAR[
            dayVerdict({
              schedule: resolveSchedule(versions, habit.start_date, date),
              status: logs.get(date) ?? null,
              date,
              today: on,
              archivedOn: habit.archived_on,
            })
          ],
      )
      .join(""),
    // Every version, oldest first — the record of what was asked of this habit
    // over time, which is a fact about it and not an interpretation of it.
    versions: versions.map(shapeSchedule),
    notes,
    /* The cursor for the next page, or null at the end of the record. Sent
       rather than left for the client to take from the last row, so an empty
       page cannot be followed by a request for the day before nothing. */
    next_before: more && notes.length > 0 ? notes[notes.length - 1].date : null,
  });
}

export async function create(req, res) {
  const body = createBody.parse(req.body);

  const habit = await habits.createHabit({
    name: body.name,
    colorToken: body.color_token,
    // A habit with no start date starts now; backdating one is allowed so a
    // habit already under way can be entered with its history intact.
    startDate: body.start_date ?? today(),
    unit: body.unit ?? null,
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
    // Key presence, not the value: `unit: null` clears it and an absent key
    // leaves it alone, and null cannot tell those apart on its own.
    unitGiven: "unit" in body,
    unit: body.unit ?? null,
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

  res.json({
    log: await habits.setLog(id, date, {
      status: body.status,
      value: body.value,
      note: body.note,
    }),
  });
}

export async function clearLog(req, res) {
  await habits.clearLog(idParam.parse(req.params.id), isoDate.parse(req.params.date));
  res.status(204).end();
}
