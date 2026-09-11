/**
 * Journal routes.
 *
 * Two explicit kinds rather than a ?kind= parameter, because both can exist on
 * the same date: a monthly reflection is anchored to the 1st, where a daily
 * entry may also live.
 */
import { z } from "zod";

import { isoDate, isoMonth } from "../../lib/schemas.js";
import * as journal from "./journal.service.js";

// The database also enforces this (journal_entry_not_blank); trimming here is
// what turns "whitespace only" into a readable 400 instead of a constraint
// violation, and keeps stored entries free of trailing blanks.
const entryBody = z.object({ entry: z.string().trim().min(1).max(10_000) });

export async function getDay(req, res) {
  const date = isoDate.parse(req.params.date);
  res.json({ entry: await journal.loadEntry(date, "day") });
}

export async function putDay(req, res) {
  const date = isoDate.parse(req.params.date);
  const { entry } = entryBody.parse(req.body);
  res.json({ entry: await journal.saveEntry(date, "day", entry) });
}

export async function deleteDay(req, res) {
  await journal.removeEntry(isoDate.parse(req.params.date), "day");
  res.status(204).end();
}

export async function getMonth(req, res) {
  const anchor = journal.monthAnchor(isoMonth.parse(req.params.month));
  res.json({ entry: await journal.loadEntry(anchor, "month") });
}

export async function putMonth(req, res) {
  const anchor = journal.monthAnchor(isoMonth.parse(req.params.month));
  const { entry } = entryBody.parse(req.body);
  res.json({ entry: await journal.saveEntry(anchor, "month", entry) });
}

export async function deleteMonth(req, res) {
  await journal.removeEntry(journal.monthAnchor(isoMonth.parse(req.params.month)), "month");
  res.status(204).end();
}
