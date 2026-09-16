/**
 * The Notifications section of the settings column on /habits.
 *
 * One section, six switches and two clocks — not a dashboard. Everything about
 * WHEN a particular habit or task is reminded lives with that habit or that
 * task, in its own editor, because that is where you are when you decide it.
 * What is here is only what is true of the app as a whole.
 *
 * It is calm on purpose and it states facts. There is no badge, no count, no
 * warning colour and nothing that moves: the strongest thing on the screen is a
 * sentence saying where reminders come from. A reminder is not a
 * score, and a settings screen that nags about its own configuration is the
 * first step to a product that nags about everything else.
 */
import { useEffect, useState } from "react";

import { FIELD, PRIMARY, QUIET } from "../../components/form";
import { usePatchReminderSettings, useReminderSettings } from "./queries";
import {
  isSubscribed,
  subscribeThisDevice,
  unsubscribeThisDevice,
  useNotificationPermission,
} from "./push";
import type { ClockTime } from "../../types";

/**
 * A switch as a row: the platform's checkbox, the app's rule. Same shape as the
 * Paused control in HabitEditor, which is the one this borrows from — a bordered
 * row is how this system draws a thing you turn on, as opposed to a position on
 * a dial (Choice) or a key that does something (PRIMARY).
 */
function Toggle({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="border-baseline flex min-h-12 cursor-pointer items-center gap-3 border px-3.5 transition-opacity has-[:disabled]:cursor-default has-[:disabled]:opacity-40 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-ink h-4 w-4 shrink-0"
      />
      <span className="flex-1">{label}</span>
    </label>
  );
}

/** A labelled clock. `type="time"` so the phone brings its own wheel. */
function TimeField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: ClockTime;
  onChange: (next: ClockTime) => void;
}) {
  return (
    <div className="flex-1">
      <label htmlFor={id} className="label text-muted block pb-1.5">
        {label}
      </label>
      <input
        id={id}
        type="time"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={FIELD}
      />
    </div>
  );
}

/** The default a time control opens on when it is being turned on. */
const DEFAULT_TIME = "20:00";
const DEFAULT_QUIET_START = "22:00";
const DEFAULT_QUIET_END = "07:00";

export function Notifications() {
  const query = useReminderSettings();
  const patch = usePatchReminderSettings();
  const { permission, request } = useNotificationPermission();

  const settings = query.data?.settings;
  const publicKey = query.data?.push_public_key ?? null;
  const configured = query.data?.push_configured ?? false;

  /*
   * Whether THIS device holds a subscription — a per-device fact, so it comes
   * from the browser rather than from the settings row. The master switch is
   * app-wide: a phone that is subscribed and a laptop that is not can both be
   * true at once, and only the browser knows which one you are looking at.
   */
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void isSubscribed(publicKey).then((result) => live && setSubscribed(result));
    return () => {
      live = false;
    };
  }, [publicKey, permission]);

  if (!settings) return null;

  const save = (next: Parameters<typeof patch.mutate>[0]) => patch.mutate(next);

  /**
   * Turning reminders on subscribes this device before the switch is stored,
   * and turning them off unsubscribes it after. Either way the browser and the
   * server agree at the end — a stored "on" with no subscription is a switch
   * that says reminders are coming when nothing can carry one.
   */
  const toggleMaster = async (next: boolean) => {
    setBusy(true);
    setFailure(null);
    try {
      if (next) {
        if (publicKey) await subscribeThisDevice(publicKey);
        setSubscribed(true);
        save({ notifications_enabled: true });
      } else {
        save({ notifications_enabled: false });
        await unsubscribeThisDevice();
        setSubscribed(false);
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not reach the push service.");
      setSubscribed(await isSubscribed(publicKey));
    } finally {
      setBusy(false);
    }
  };

  const subscribeHere = async () => {
    if (!publicKey) return;
    setBusy(true);
    setFailure(null);
    try {
      await subscribeThisDevice(publicKey);
      setSubscribed(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not subscribe this device.");
    } finally {
      setBusy(false);
    }
  };

  const on = settings.notifications_enabled;
  const quiet = settings.quiet_start !== null && settings.quiet_end !== null;

  /*
   * The browser's answer, never the app's. Two of the three states are things
   * this app cannot change from here: only the browser can grant permission,
   * and only its own settings can take a refusal back. Saying otherwise — a
   * button that re-asks after a denial, a "try again" that cannot — is the one
   * dishonest thing a permission UI can do, so the denied case explains where
   * the switch actually is instead.
   */
  const permissionLine =
    permission === "unsupported" ? (
      <p className="text-meta text-muted">
        This browser cannot show notifications. Everything else works as it does anywhere else.
      </p>
    ) : permission === "granted" ? (
      <p className="text-meta text-muted">Notifications are allowed by your browser.</p>
    ) : permission === "denied" ? (
      <p className="text-meta text-muted">
        Your browser is blocking notifications for this site. Nothing here can override that — turn
        them back on in the browser’s site settings for this page (on a phone, the padlock or “ⓘ”
        beside the address, then Notifications), and this line will change.
      </p>
    ) : (
      <div className="grid gap-2">
        <p className="text-meta text-muted">
          Your browser has not been asked yet. Reminders need its permission before anything can be
          shown.
        </p>
        {/* justify-self, because this is a grid item: an inline-flex box still
            stretches to the column unless it is told where to sit. */}
        <span className="inline-flex justify-self-start">
          {/* PRIMARY carries w-full, and a width utility written after it does
              not win — Tailwind emits them in its own order. The inline-flex
              box is what makes this button the size of its label. */}
          <button type="button" className={PRIMARY} onClick={() => void request()}>
            Allow notifications
          </button>
        </span>
      </div>
    );

  return (
    <section aria-labelledby="notifications-heading">
      <h3 id="notifications-heading" className="label text-muted pb-2.5">
        Notifications
      </h3>

      <div className="grid gap-3">
        {permissionLine}

        {!configured && (
          <p className="text-meta text-muted">
            This server has no push keys set, so nothing can be sent yet — see VAPID_PUBLIC_KEY and
            VAPID_PRIVATE_KEY in its environment.
          </p>
        )}

        <Toggle
          label="Reminders"
          checked={on}
          disabled={permission !== "granted" || !configured || busy}
          onChange={(next) => void toggleMaster(next)}
        />

        {/*
         * Per-device, and said only when it disagrees with the switch above.
         * The switch is the app's; the subscription is this browser's, so a
         * second device arrives here with reminders already "on" and nothing
         * registered for it — which is precisely the case that needs a button
         * rather than an explanation.
         */}
        {on && permission === "granted" && configured && !subscribed && (
          <div className="grid gap-2">
            <p className="text-meta text-muted">This device is not registered for reminders yet.</p>
            <span className="inline-flex justify-self-start">
              <button
                type="button"
                className={QUIET}
                disabled={busy}
                onClick={() => void subscribeHere()}
              >
                {busy ? "Registering…" : "Use reminders on this device"}
              </button>
            </span>
          </div>
        )}

        {failure && (
          <p role="alert" className="text-warn text-meta">
            {failure}
          </p>
        )}

        {/* The three kinds and the quiet window are only meaningful while the
            master switch is on, so they are not rendered when it is off. Not
            disabled-and-shown: a column of eight dimmed controls is exactly the
            configuration dashboard this screen must not become. */}
        {on && (
          <div className="border-grid grid gap-3 border-l pl-3.5">
            <Toggle
              label="Habits"
              checked={settings.habit_reminders}
              onChange={(next) => save({ habit_reminders: next })}
            />
            <Toggle
              label="Tasks"
              checked={settings.task_reminders}
              onChange={(next) => save({ task_reminders: next })}
            />
            <p className="text-meta text-muted">
              Each habit and each dated task keeps its own time, set where you edit it. A habit is
              only reminded on a day it is actually scheduled for, and never while it is paused.
            </p>

            <Toggle
              label="LeetCode review"
              checked={settings.leetcode_reminder_at !== null}
              onChange={(next) => save({ leetcode_reminder_at: next ? DEFAULT_TIME : null })}
            />
            {settings.leetcode_reminder_at !== null && (
              <>
                <TimeField
                  id="leetcode-reminder"
                  label="At"
                  value={settings.leetcode_reminder_at}
                  onChange={(value) => save({ leetcode_reminder_at: value })}
                />
                <p className="text-meta text-muted">
                  Once a day, and only when something is actually waiting. Nothing is overdue and
                  nothing is counted.
                </p>
              </>
            )}

            <Toggle
              label="Quiet hours"
              checked={quiet}
              onChange={(next) =>
                save(
                  next
                    ? { quiet_start: DEFAULT_QUIET_START, quiet_end: DEFAULT_QUIET_END }
                    : { quiet_start: null, quiet_end: null },
                )
              }
            />
            {quiet && (
              <>
                <div className="flex gap-3">
                  <TimeField
                    id="quiet-start"
                    label="From"
                    value={settings.quiet_start!}
                    onChange={(value) =>
                      save({ quiet_start: value, quiet_end: settings.quiet_end })
                    }
                  />
                  <TimeField
                    id="quiet-end"
                    label="To"
                    value={settings.quiet_end!}
                    onChange={(value) =>
                      save({ quiet_start: settings.quiet_start, quiet_end: value })
                    }
                  />
                </div>
                <p className="text-meta text-muted">
                  A window that runs past midnight is read as one — 22:00 to 07:00 is the night.
                  Anything that falls inside it is not shown, and is not saved up for the morning.
                </p>
              </>
            )}
          </div>
        )}

        {patch.isError && (
          <p role="alert" className="text-warn text-meta">
            {patch.error.message}
          </p>
        )}

        {/*
         * The limitation, said plainly and not in a footnote. There is no push
         * service behind this, so nothing arrives with the app closed; a
         * reminder you have not seen yet is delivered when you next open it.
         * Promising more than that is worse than reminding you of less.
         */}
        <p className="text-meta text-muted">
          Reminders are sent by the server and arrive even with the app closed, as long as this
          device is online and the browser is not stopped by the system. Each one is sent once, at
          its time — nothing is saved up and delivered later.
        </p>
      </div>
    </section>
  );
}
