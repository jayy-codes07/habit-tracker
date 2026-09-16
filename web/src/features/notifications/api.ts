/**
 * Reminders — the app-wide settings, and this device's push subscription.
 *
 * A habit's and a task's own reminder time are NOT here: they are fields on
 * those rows and are written through their own PATCH, in features/habits and
 * features/tasks. There is no reminder resource, by design — and no "what is
 * due" call either: the server pushes that to the service worker.
 */
import { send, sendJson, request } from "../../lib/api-client";
import type { ClockTime, ReminderSettingsPayload } from "../../types";

/**
 * Every field is optional and the three nullable ones mean something when sent
 * as null — no LeetCode reminder, no quiet hours. The server reads key
 * presence, so omitting a field leaves it alone and sending null clears it.
 *
 * The two quiet ends travel together or not at all; the server refuses half a
 * window with a 400 rather than storing something it would have to guess at.
 */
export interface ReminderSettingsPatch {
  notifications_enabled?: boolean;
  habit_reminders?: boolean;
  task_reminders?: boolean;
  leetcode_reminder_at?: ClockTime | null;
  quiet_start?: ClockTime | null;
  quiet_end?: ClockTime | null;
}

/**
 * The settings, and the two facts a browser needs before it can subscribe: the
 * VAPID public key and whether this deployment has one at all. The public key
 * is meant to be here — it is what the subscription is signed to. The private
 * half never leaves the server.
 */
export const getReminderSettings = () => request<ReminderSettingsPayload>("/reminders");

export const patchReminderSettings = (patch: ReminderSettingsPatch) =>
  sendJson<{ settings: ReminderSettingsPayload["settings"] }>("PATCH", "/reminders", patch);

/**
 * Registers this device with the server, exactly as the browser produced it —
 * `PushSubscription.toJSON()`, whose `keys` the server stores verbatim and
 * hands straight to the encryption. Re-sending the same subscription refreshes
 * it rather than adding a second row.
 */
export const subscribePush = (subscription: { endpoint: string; keys: Record<string, string> }) =>
  send("POST", "/reminders/subscription", subscription);

/** Forgets this device. 204 whether or not the server had ever heard of it. */
export const unsubscribePush = (endpoint: string) =>
  send("DELETE", "/reminders/subscription", { endpoint });
