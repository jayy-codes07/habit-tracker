/**
 * The schedule as the two dialogs hold it while it is being edited, before it
 * becomes the API's shape.
 *
 * Pausing is not a draft kind: it is something you do to a habit, not a way of
 * describing one, and offering it as a third kind would let someone create a
 * habit that is paused from the moment it exists.
 *
 * `target` — the amount asked for on one occasion — rides on both kinds rather
 * than being a kind of its own. It is unrelated to a weekly draft's `target`
 * count, which is why they are named apart here: `target` counts occasions,
 * `amount` measures each one. Three times a week, five kilometres each.
 */
import type { Schedule, ScheduleInput, Weekday } from "../../types";

/** The amount asked for on one occasion. Null is valid: measure, aim at nothing. */
export type Amount = number | null;

export type ScheduleDraft =
  | { kind: "fixed"; days: Weekday[]; amount: Amount }
  | { kind: "weekly"; target: number; amount: Amount };

export const EVERY_DAY: Weekday[] = [1, 2, 3, 4, 5, 6, 7];

/**
 * The bounds the server enforces, mirrored so a bad amount is caught before it
 * becomes a 400. numeric(10, 2) rounds on the way in, so anything under the
 * storable precision would silently become zero.
 */
export const MIN_AMOUNT = 0.01;
export const MAX_AMOUNT = 99_999_999.99;

/**
 * The draft as it can actually be saved, given the unit the habit is going to
 * have — which is the one in the box being edited, not the one last stored.
 *
 * A habit with no unit cannot hold a target: the server refuses one on a
 * schedule change, and a create that sent one used to commit a habit with no
 * schedule version at all. So the amount goes when the unit does, in the same
 * breath that the picker stops offering a field for it. The draft itself is
 * left alone, so re-typing a unit that was deleted by mistake brings the amount
 * back rather than making it retypable only from memory.
 */
export const draftFor = (draft: ScheduleDraft, unit: string | null): ScheduleDraft =>
  unit === null ? { ...draft, amount: null } : draft;

export const isAmountValid = (amount: Amount) =>
  amount === null || (Number.isFinite(amount) && amount >= MIN_AMOUNT && amount <= MAX_AMOUNT);

export const toScheduleInput = (draft: ScheduleDraft): ScheduleInput =>
  draft.kind === "fixed"
    ? { schedule_kind: "fixed", schedule_days: draft.days, target_value: draft.amount }
    : { schedule_kind: "weekly", weekly_target: draft.target, target_value: draft.amount };

export const isDraftValid = (draft: ScheduleDraft) =>
  isAmountValid(draft.amount) && (draft.kind === "weekly" || draft.days.length > 0);

/**
 * Whether the draft already says what the habit's current version says.
 *
 * Saving an unchanged schedule would append a redundant version dated today,
 * which is harmless but clutters a history that is meant to read as a record of
 * real decisions.
 *
 * The amount is compared for both kinds, and on its own it is enough to make a
 * save: changing only the target — five kilometres becoming eight, with the same
 * days — is a real decision and has to be storable as one.
 */
export const matchesSchedule = (current: Schedule | null, draft: ScheduleDraft) => {
  if (!current) return false;
  if (current.target_value !== draft.amount) return false;

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
 * a paused version: it stores no days, no target and no amount, so the fallback
 * below is all that is left and the habit silently becomes an every-day one on
 * save, measuring nothing.
 *
 * The fallback is therefore only for a habit that genuinely never asked for
 * anything: `resumes_to` is null when a habit was paused from its first version.
 */
export const draftOf = (current: Schedule | null): ScheduleDraft => {
  // Carried through a pause along with the days: resuming a habit that asked
  // for five kilometres must not resume it asking for nothing.
  const amount = current?.target_value ?? null;

  if (current?.schedule_kind === "weekly") {
    return { kind: "weekly", target: current.weekly_target ?? 3, amount };
  }
  if (current?.schedule_kind === "fixed" && current.schedule_days?.length) {
    return { kind: "fixed", days: current.schedule_days, amount };
  }
  return { kind: "fixed", days: EVERY_DAY, amount };
};
