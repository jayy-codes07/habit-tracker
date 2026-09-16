/**
 * The clock behind Web Push: one interval, in the server process.
 *
 * This is the piece that makes a reminder arrive with the app closed. Nothing
 * on the device is running; the server notices the time has come, and pushes.
 *
 * It is a setInterval and not a cron container, a queue or a job runner,
 * because the work it schedules is three indexed reads a minute for one person.
 * The things a real scheduler buys — distribution, retries, backfill, a
 * durable job record — are all either unnecessary here or actively wrong: a
 * missed minute must NOT be backfilled, or reopening the app after an outage
 * delivers a morning's worth of notifications at once.
 *
 * It lives in server.js's process and nowhere else. createApp() must not start
 * it, or every test that builds an app would start a timer that outlives it and
 * writes to the database it is rolling back.
 *
 * ponytail: single-process timer. If this ever runs as two instances, two of
 * them tick — the claim in reminder_deliveries still makes exactly one win, so
 * the failure mode is a wasted query rather than a duplicate notification.
 */
import { config } from "../../config/index.js";
import { pushConfigured } from "../../lib/push.js";
import { deliverDue } from "./reminders.service.js";

/**
 * Starts the loop and hands back the stopper.
 *
 * Ticks are serialised by a flag rather than by a lock: a tick that somehow
 * outlives its interval must not have a second one start beside it, and for one
 * timer in one process a boolean is the whole of that problem.
 */
export function startReminderScheduler() {
  if (!pushConfigured()) {
    console.log("[push] no VAPID keys configured - reminders will not be sent");
    return () => {};
  }

  const every = Math.max(15, config.reminderTickSeconds) * 1000;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const sent = await deliverDue();
      if (sent > 0) console.log(`[push] sent ${sent} reminder(s)`);
    } catch (error) {
      // A failed tick is a minute with no reminders, not a dead server. The
      // next one asks again, and nothing was claimed that was not delivered.
      console.error("[push] tick failed:", error.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), every);
  console.log(`[push] reminder scheduler started (every ${every / 1000}s)`);

  return () => clearInterval(timer);
}
