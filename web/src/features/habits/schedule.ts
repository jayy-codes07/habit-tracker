/**
 * The schedule as the two dialogs hold it while it is being edited, before it
 * becomes the API's shape.
 *
 * Pausing is not a draft kind: it is something you do to a habit, not a way of
 * describing one, and offering it as a third kind would let someone create a
 * habit that is paused from the moment it exists.
 */
import type { Schedule, ScheduleInput, Weekday } from "../../types";

export type ScheduleDraft = { kind: "fixed"; days: Weekday[] } | { kind: "weekly"; target: number };

export const EVERY_DAY: Weekday[] = [1, 2, 3, 4, 5, 6, 7];

export const toScheduleInput = (draft: ScheduleDraft): ScheduleInput =>
  draft.kind === "fixed"
    ? { schedule_kind: "fixed", schedule_days: draft.days }
    : { schedule_kind: "weekly", weekly_target: draft.target };

export const isDraftValid = (draft: ScheduleDraft) =>
  draft.kind === "weekly" || draft.days.length > 0;

/**
 * Whether the draft already says what the habit's current version says.
 *
 * Saving an unchanged schedule would append a redundant version dated today,
 * which is harmless but clutters a history that is meant to read as a record of
 * real decisions.
 */
export const matchesSchedule = (current: Schedule | null, draft: ScheduleDraft) => {
  if (!current) return false;
  if (draft.kind === "weekly") {
    return current.schedule_kind === "weekly" && current.weekly_target === draft.target;
  }
  const days = current.schedule_days ?? [];
  return (
    current.schedule_kind === "fixed" &&
    days.length === draft.days.length &&
    days.every((day) => draft.days.includes(day))
  );
};

/**
 * The draft a schedule version should open in a picker as.
 *
 * Callers pass the habit's current version, or — when it is paused — the
 * server's `resumes_to`, which is the version the pause interrupted. Never pass
 * a paused version: it stores no days and no target, so the fallback below is
 * all that is left and the habit silently becomes an every-day one on save.
 *
 * The fallback is therefore only for a habit that genuinely never asked for
 * anything: `resumes_to` is null when a habit was paused from its first version.
 */
export const draftOf = (current: Schedule | null): ScheduleDraft =>
  current?.schedule_kind === "weekly"
    ? { kind: "weekly", target: current.weekly_target ?? 3 }
    : current?.schedule_kind === "fixed" && current.schedule_days?.length
      ? { kind: "fixed", days: current.schedule_days }
      : { kind: "fixed", days: EVERY_DAY };
