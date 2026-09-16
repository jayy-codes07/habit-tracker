/**
 * Reminder settings, and the one endpoint that decides what is due.
 *
 * The times a habit or a task is reminded at live on those rows and are set
 * through their own PATCH — a reminder is a property of the thing, not a
 * separate object to manage. What is here is the app-wide part: the master
 * switch, the three kinds, and quiet hours.
 */
import { z } from "zod";

import { config } from "../../config/index.js";
import { badRequest } from "../../lib/errors.js";
import { pushConfigured } from "../../lib/push.js";
import { clockTime } from "../../lib/schemas.js";
import * as reminders from "./reminders.service.js";

/**
 * Nullable on purpose, twice over: sending null for the LeetCode time turns
 * that reminder off, and sending null for both quiet ends removes the window.
 * Which of the two was meant is decided by key presence, never by the value.
 */
const settingsBody = z
  .object({
    notifications_enabled: z.boolean().optional(),
    habit_reminders: z.boolean().optional(),
    task_reminders: z.boolean().optional(),
    leetcode_reminder_at: clockTime.nullish(),
    quiet_start: clockTime.nullish(),
    quiet_end: clockTime.nullish(),
  })
  .refine((body) => Object.keys(body).length > 0, "nothing to update");

/**
 * A subscription as the browser produces it — PushSubscription.toJSON().
 *
 * The endpoint is checked for being an absolute https URL because it is a
 * string this server will later POST to: anything else is either a mistake or
 * an attempt to make the server fetch something, and the database refuses it
 * too. The keys are opaque and are stored exactly as sent; re-encoding a key
 * is a way to corrupt one.
 */
const subscriptionBody = z.object({
  endpoint: z.string().url().startsWith("https://").max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
});

const unsubscribeBody = z.object({ endpoint: z.string().max(2000) });

/**
 * The settings, plus the two facts the client needs to subscribe at all: the
 * VAPID PUBLIC key — which is meant to reach the browser, it is what
 * pushManager.subscribe() signs the subscription to — and whether this
 * deployment can push at all, so the interface can say so instead of offering a
 * switch that silently does nothing.
 *
 * The private key is not here and is not anywhere a payload can reach it.
 */
export async function settings(_req, res) {
  res.json({
    settings: await reminders.loadSettings(),
    push_configured: pushConfigured(),
    push_public_key: pushConfigured() ? config.vapid.publicKey : null,
  });
}

/** Subscribes this device, or refreshes the keys of one already known. */
export async function subscribe(req, res) {
  const body = subscriptionBody.parse(req.body);
  await reminders.saveSubscription({
    endpoint: body.endpoint,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
  });
  res.status(204).end();
}

/**
 * Forgets this device. 204 whether or not it was known: the caller's intent is
 * satisfied either way, and a 404 here would only invite it to care.
 */
export async function unsubscribe(req, res) {
  await reminders.removeSubscription(unsubscribeBody.parse(req.body).endpoint);
  res.status(204).end();
}

export async function update(req, res) {
  const body = settingsBody.parse(req.body);

  /*
   * The two ends of the window are one setting and are sent together or not at
   * all. The database refuses a half-filled pair, but a constraint violation
   * carries no status and would be logged as a 500 for what is a client sending
   * half a window — so it is said here as a 400 as well.
   */
  const quietGiven = "quiet_start" in body || "quiet_end" in body;
  if (quietGiven && Boolean(body.quiet_start) !== Boolean(body.quiet_end)) {
    throw badRequest("Quiet hours need both a start and an end, or neither");
  }
  if (quietGiven && body.quiet_start && body.quiet_start === body.quiet_end) {
    throw badRequest("Quiet hours cannot start and end at the same time");
  }

  res.json({
    settings: await reminders.updateSettings({
      notificationsEnabled: body.notifications_enabled,
      habitReminders: body.habit_reminders,
      taskReminders: body.task_reminders,
      leetcodeGiven: "leetcode_reminder_at" in body,
      leetcodeReminderAt: body.leetcode_reminder_at ?? null,
      quietGiven,
      quietStart: body.quiet_start ?? null,
      quietEnd: body.quiet_end ?? null,
    }),
  });
}
