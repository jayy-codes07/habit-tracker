/**
 * Reminders: the settings row, and deciding what is due right now.
 *
 * This module owns two small tables and composes the others, the way overview/
 * does — a reminder is not a record of its own, it is a question asked about
 * habits, tasks and the review queue at a moment in time. Nothing about
 * eligibility is stored: a paused habit, an archived one, a completed task and
 * an empty queue are all read fresh on every check, so a reminder can never
 * outlive the reason it existed.
 *
 * The one thing that IS stored is what has already been delivered, because that
 * is the only fact the app cannot recompute — see claim().
 *
 * Times here are wall-clock 'HH:MM' in APP_TIMEZONE, from lib/dates.js and
 * never from the server's clock or the browser's. 'HH:MM' compares
 * lexicographically, exactly as an ISO date does, so `<=` is the whole of the
 * arithmetic.
 */
import { query } from "../../db/index.js";
import { addDays, nowTime, today } from "../../lib/dates.js";
import { isGone, pushConfigured, sendPush } from "../../lib/push.js";
import { isScheduledOn, resolveSchedule } from "../../lib/scheduling.js";
import * as habitsService from "../habits/habits.service.js";
import * as leetcodeService from "../leetcode/leetcode.service.js";

const SETTINGS_COLUMNS = `notifications_enabled, habit_reminders, task_reminders,
                          leetcode_reminder_at, quiet_start, quiet_end, updated_at`;

/**
 * Postgres hands a `time` back as 'HH:MM:SS'. The API speaks 'HH:MM' — the
 * seconds are always zero, an <input type="time"> neither shows nor sends them,
 * and a payload that says 08:30:00 invites a client to parse what it could
 * compare.
 */
const hhmm = (value) => (value === null || value === undefined ? null : String(value).slice(0, 5));

const shapeSettings = (row) => ({
  notifications_enabled: row.notifications_enabled,
  habit_reminders: row.habit_reminders,
  task_reminders: row.task_reminders,
  leetcode_reminder_at: hhmm(row.leetcode_reminder_at),
  quiet_start: hhmm(row.quiet_start),
  quiet_end: hhmm(row.quiet_end),
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The one row. It is inserted by the migration, so this cannot come back empty. */
export async function loadSettings() {
  const { rows } = await query(`SELECT ${SETTINGS_COLUMNS} FROM app_settings WHERE id = 1`);
  return shapeSettings(rows[0]);
}

/**
 * A partial update of the one row.
 *
 * Three fields are nullable and null means something on each — no LeetCode
 * reminder, no quiet hours — so every one of them needs its own "was it sent at
 * all" flag rather than COALESCE, which cannot tell "leave it alone" from
 * "clear it". The two quiet-hour ends travel together for the same reason the
 * CHECK constraint pairs them: half a window is not a window.
 */
export async function updateSettings(patch) {
  const { rows } = await query(
    `UPDATE app_settings
        SET notifications_enabled = COALESCE($1::boolean, notifications_enabled),
            habit_reminders       = COALESCE($2::boolean, habit_reminders),
            task_reminders        = COALESCE($3::boolean, task_reminders),
            leetcode_reminder_at  = CASE WHEN $4::boolean THEN $5::time ELSE leetcode_reminder_at END,
            quiet_start           = CASE WHEN $6::boolean THEN $7::time ELSE quiet_start END,
            quiet_end             = CASE WHEN $6::boolean THEN $8::time ELSE quiet_end END
      WHERE id = 1
      RETURNING ${SETTINGS_COLUMNS}`,
    [
      patch.notificationsEnabled ?? null,
      patch.habitReminders ?? null,
      patch.taskReminders ?? null,
      patch.leetcodeGiven ?? false,
      patch.leetcodeReminderAt ?? null,
      patch.quietGiven ?? false,
      patch.quietStart ?? null,
      patch.quietEnd ?? null,
    ],
  );
  return shapeSettings(rows[0]);
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

/**
 * Whether `now` falls inside the quiet window.
 *
 * The overnight case is the whole of the difficulty and is handled by reading
 * the window as two: 22:30 → 07:30 is "at or after 22:30, OR before 07:30".
 * Written as a comparison on 'HH:MM' strings rather than minute arithmetic
 * because the strings already sort correctly and there is nothing to get
 * backwards.
 *
 * A window whose ends are equal is no window at all. Postgres would happily
 * store it, and reading it as "always quiet" would silently disable every
 * reminder — the interface refuses it too, but the silent reading is the one
 * worth being explicit about here.
 */
export function inQuietHours(now, start, end) {
  if (!start || !end || start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

// ---------------------------------------------------------------------------
// What is due
// ---------------------------------------------------------------------------

/**
 * Habits whose reminder time has passed today and that today actually asks
 * something of.
 *
 * Four exclusions, and all four are read from the same facts the day screen
 * reads, never from a flag beside the reminder:
 *
 *   - archived — never notifies, at all;
 *   - paused — a pause asks for nothing, so there is nothing to be reminded of;
 *   - not scheduled today — a Tue/Thu habit is silent on Wednesday. A *weekly*
 *     habit is scheduled on no particular day (isScheduledOn is false for every
 *     one of them), so it is eligible on any day its week is still open, which
 *     is the same reading isActionable() gives the day screen;
 *   - already logged today — done, missed or skipped, the day has been decided
 *     and a reminder would be asking about something already answered.
 *
 * A schedule version dated in the future is respected for free: resolveSchedule
 * takes the version in force on the date asked for, so a habit that becomes
 * Mon/Wed next week is still Tue/Thu today.
 */
async function dueHabits(date, now) {
  const { rows } = await query(
    `SELECT h.id, h.name, h.start_date
       FROM habits h
      WHERE h.archived_at IS NULL
        AND h.reminder_at IS NOT NULL
        AND h.reminder_at <= $1::time
        AND NOT EXISTS (
          SELECT 1 FROM habit_logs l WHERE l.habit_id = h.id AND l.date = $2
        )
      ORDER BY h.sort_order, h.id`,
    [now, date],
  );
  if (rows.length === 0) return [];

  const versions = await habitsService.loadVersions(rows.map((row) => row.id));

  return rows
    .filter((habit) => {
      const schedule = resolveSchedule(versions.get(habit.id) ?? [], habit.start_date, date);
      if (!schedule || schedule.schedule_kind === "paused") return false;
      return schedule.schedule_kind === "weekly" || isScheduledOn(schedule, date);
    })
    .map((habit) => ({
      key: `habit:${habit.id}`,
      kind: "habit",
      title: habit.name,
      // Neutral, and a statement of fact rather than a demand. Nothing here
      // mentions a streak, a run, or what happens if you do not.
      body: "Scheduled for today.",
      href: "/",
    }));
}

/**
 * Tasks due today whose reminder time has passed.
 *
 * Only a dated task can carry one at all — tasks_reminder_needs_date — so the
 * "Anytime" list is silent by construction rather than by a filter that could
 * be forgotten. Completed and archived are excluded here, for the reason every
 * task query excludes archived: the partial index says nothing about it.
 *
 * Overdue tasks are deliberately NOT reminded about again. A due date is never
 * rewritten by this app, and a reminder that returns every morning until you
 * comply is the escalation this feature is not allowed to become.
 */
async function dueTasks(date, now) {
  const { rows } = await query(
    `SELECT id, title
       FROM tasks
      WHERE archived_at IS NULL
        AND NOT completed
        AND due_date = $2
        AND reminder_at IS NOT NULL
        AND reminder_at <= $1::time
      ORDER BY created_at, id`,
    [now, date],
  );

  return rows.map((task) => ({
    key: `task:${task.id}`,
    kind: "task",
    title: task.title,
    body: "Due today.",
    href: "/tasks",
  }));
}

/**
 * The review queue, if there is one.
 *
 * One reminder for the whole queue rather than one per problem: the queue is a
 * workload, and a phone that buzzes nine times has turned it into a backlog to
 * feel bad about. The count is said plainly and no deadline is implied — a
 * problem waiting a month is in exactly the same state as one waiting a day,
 * because "needs review" is derived from two facts and neither of them is a
 * date you were supposed to meet.
 */
async function dueLeetcode(at, now) {
  if (!at || at > now) return [];

  const count = await leetcodeService.countNeedingReview();
  if (count === 0) return [];

  return [
    {
      key: "leetcode",
      kind: "leetcode",
      title: "LeetCode",
      body:
        count === 1
          ? "One problem is waiting for review."
          : `${count} problems are waiting for review.`,
      href: "/leetcode",
    },
  ];
}

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------

/** A week is long enough to debug a duplicate and short enough to stay tiny. */
const KEEP_DAYS = 7;

/**
 * Takes the reminders that have not been delivered yet, and marks them
 * delivered in the same statement.
 *
 * This is the whole of duplicate prevention, and it is one round trip on
 * purpose. A refresh, a second tab, an app reopened twice in a minute and a
 * scheduler that fired twice all arrive here with the same keys; the primary
 * key on (key, on_date) decides, and the losers get back an empty list rather
 * than a second notification. Doing it in JavaScript — a Set, a lock, a
 * localStorage flag — would be per-tab and per-install, which is exactly the
 * case that produces the duplicate.
 *
 * It is a write, which is why the endpoint is a POST: asking what is due is
 * inseparable from recording that it was answered.
 */
async function claim(candidates, date) {
  if (candidates.length === 0) return [];

  const { rows } = await query(
    `INSERT INTO reminder_deliveries (key, on_date)
     SELECT unnest($1::text[]), $2
     ON CONFLICT DO NOTHING
     RETURNING key`,
    [candidates.map((candidate) => candidate.key), date],
  );

  const claimed = new Set(rows.map((row) => row.key));
  return candidates.filter((candidate) => claimed.has(candidate.key));
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * One row per subscribed device: the endpoint the push service gave the
 * browser, and the two keys the payload is encrypted to.
 *
 * Kept out of every payload the app sends. Anyone holding these three strings
 * can push to that device, which is the whole reason they are server-side, and
 * why there is no endpoint that lists them.
 */
export async function loadSubscriptions() {
  const { rows } = await query(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions ORDER BY id`,
  );
  return rows;
}

/**
 * Stores a subscription, or refreshes the one this device already has.
 *
 * The endpoint is the browser's own identifier for it, so re-subscribing —
 * which a browser may do on its own when it rotates keys — updates the keys in
 * place rather than leaving a dead row beside a live one. `created_at` is left
 * alone on a refresh: it is when this device subscribed, not when it last
 * checked in.
 */
export async function saveSubscription({ endpoint, p256dh, auth }) {
  await query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth)
     VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [endpoint, p256dh, auth],
  );
}

/**
 * Forgets a device. Idempotent on purpose: unsubscribing twice, or
 * unsubscribing something the server never knew about, is not an error — the
 * caller's intent (this device should not be pushed to) is satisfied either
 * way, and reporting a 404 would only invite the client to care.
 */
export async function removeSubscription(endpoint) {
  await query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * The scheduler's one job: find what is due and push it.
 *
 * The order is deliberate and the trade-off is explicit. dueNow() CLAIMS before
 * anything is sent, so a push that fails in transit is lost rather than
 * repeated. For a reminder that is the right way round: a notification you
 * never saw is a missed nudge, and a notification you saw four times is the app
 * becoming something you turn off. The push service's own retry covers the
 * ordinary failures anyway — a send is accepted or refused, and a refused one
 * is nearly always a subscription that no longer exists.
 *
 * Nothing is claimed when there is nowhere to send: a deployment with no keys
 * or no subscribed device must not burn today's reminders on an audience of
 * nobody, because then subscribing a phone at noon would leave it silent until
 * tomorrow.
 */
export async function deliverDue() {
  if (!pushConfigured()) return 0;

  const subscriptions = await loadSubscriptions();
  if (subscriptions.length === 0) return 0;

  const reminders = await dueNow();
  if (reminders.length === 0) return 0;

  for (const reminder of reminders) {
    for (const subscription of subscriptions) {
      try {
        await sendPush(subscription, {
          title: reminder.title,
          body: reminder.body,
          // The thing being reminded about, so a re-delivery replaces rather
          // than stacks — and the screen to open, which is all the click
          // handler needs.
          tag: reminder.key,
          href: reminder.href,
        });
      } catch (error) {
        // 404 and 410 are the push service saying this subscription is gone —
        // the device uninstalled the app, cleared its data, or the browser
        // rotated it. Nothing else is: a 429 or a 500 is a bad minute, and
        // deleting a live device's row over one would silently end every
        // future reminder to it.
        if (isGone(error)) {
          await removeSubscription(subscription.endpoint);
        } else {
          console.error(`[push] send failed (${error.statusCode ?? "?"}): ${error.message}`);
        }
      }
    }
  }

  return reminders.length;
}

/**
 * Everything that should be shown right now, each at most once per day.
 *
 * Called by the scheduler, which pushes what it returns. It still claims what
 * it returns, which is why it is not a read: see claim().
 *
 * The order of the guards is the product's: the master switch first, then quiet
 * hours, then the individual kinds. A reminder suppressed by quiet hours is
 * dropped rather than queued — it is not claimed, so it can still fire later
 * the same day if quiet hours end before the day does, and it simply does not
 * arrive at all if they do not. Waking someone at 07:30 to tell them about
 * yesterday evening is not a reminder, it is a notification backlog.
 */
export async function dueNow() {
  const settings = await loadSettings();
  if (!settings.notifications_enabled) return [];

  const date = today();
  const now = nowTime();
  if (inQuietHours(now, settings.quiet_start, settings.quiet_end)) return [];

  // Sequential, not Promise.all: this runs on the ambient client when there is
  // a transaction — which is every test — and a node-postgres client cannot
  // have two queries in flight at once. Three cheap indexed reads once a minute
  // do not need the round trip saved, and overview/ is where fanning out pays.
  const habits = settings.habit_reminders ? await dueHabits(date, now) : [];
  const tasks = settings.task_reminders ? await dueTasks(date, now) : [];
  const leetcode = await dueLeetcode(settings.leetcode_reminder_at, now);

  const claimed = await claim([...habits, ...tasks, ...leetcode], date);

  // Swept here rather than on a timer: this is the only code path that writes
  // the table, so it is the only one that can leave rows behind, and a delete
  // of a handful of rows costs less than owning a scheduler to do it.
  await query(`DELETE FROM reminder_deliveries WHERE on_date < $1`, [addDays(date, -KEEP_DAYS)]);

  return claimed;
}
