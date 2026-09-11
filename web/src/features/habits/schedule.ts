/**
 * The schedule as the two dialogs hold it while it is being edited, before it
 * becomes the API's shape.
 *
 * Pausing is not a draft kind: it is something you do to a habit, not a way of
 * describing one, and offering it as a third kind would let someone create a
 * habit that is paused from the moment it exists.
 */
import type { ScheduleInput, Weekday } from "../../types";

export type ScheduleDraft = { kind: "fixed"; days: Weekday[] } | { kind: "weekly"; target: number };

export const EVERY_DAY: Weekday[] = [1, 2, 3, 4, 5, 6, 7];

export const toScheduleInput = (draft: ScheduleDraft): ScheduleInput =>
  draft.kind === "fixed"
    ? { schedule_kind: "fixed", schedule_days: draft.days }
    : { schedule_kind: "weekly", weekly_target: draft.target };

export const isDraftValid = (draft: ScheduleDraft) =>
  draft.kind === "weekly" || draft.days.length > 0;
