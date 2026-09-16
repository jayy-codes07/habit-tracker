/**
 * Quantity attainment: when you showed up, how close did you get?
 *
 * Deliberately a separate file from streaks.js, and deliberately not a branch
 * inside consistency(). The two answer different questions and must not be able
 * to contaminate each other:
 *
 *   occurrence consistency  did I show up as often as I said I would?
 *   quantity attainment     when I showed up, how much of the target did I do?
 *
 * The first is binding — it sets `met` and both streaks. The second is purely
 * descriptive and sets nothing. A habit can keep its commitment perfectly and
 * attain 60%, and both statements are true: `weekly × 3` commits to three
 * occasions, not to fifteen kilometres, and no amount of running on one day can
 * satisfy a three-session week. Folding the amount into the commitment score
 * would build a weekly-total habit by accident.
 *
 * This is why nothing here is imported by streaks.js and why streaks.js needs no
 * change to support quantity at all: `value` is read in this file and nowhere
 * else in lib/.
 *
 * Takes the same `habit` view as streaks.js, plus one sibling map:
 *
 *   values: Map<'YYYY-MM-DD', number>   measured amounts, quantity habits only
 *
 * A sibling rather than a widening of `logs`. Turning logs into
 * Map<date, {status, value}> would rewrite every consumer in streaks.js and
 * every fixture in its tests to prove that nothing had changed.
 */
import { eachDay } from "./dates.js";
import { resolveSchedule } from "./scheduling.js";

/**
 * How much of the per-occasion target the measured sessions reached, over a
 * window.
 *
 * A session counts when all three of these hold, which is the whole rule:
 *
 *   status is 'done'   the user's claim, not the verdict. A measured session
 *                      worked on a day nothing was asked for reports `bonus`,
 *                      and reading the verdict would make it invisible for the
 *                      sole reason that it was extra. Every measured session
 *                      counts; there are no bonus occurrences here.
 *   a value exists     "done, did not measure" is a first-class state and must
 *                      not be scored as zero. It is simply not a sample, so it
 *                      leaves both halves of the ratio rather than inflating
 *                      the numerator or padding the denominator.
 *   a target exists    resolved from the version in force on that very day, so
 *                      a day lived under a 5 km target is scored against 5 even
 *                      after the target becomes 10. Days under a paused version
 *                      have no target and so never appear — which is correct
 *                      twice over, since nothing was asked of them.
 *
 * Each session is capped at 1. Without the cap one 20 km day would carry a month
 * of 3 km days, which is the same overshoot-hides-shortfall failure that
 * consistency() already guards against when it caps done days at the weekly
 * target.
 *
 * `rate` is null when nothing was measured — not 0, which would claim the
 * sessions fell short rather than that there were none to judge. `sessions` is
 * reported alongside so a rate is never read without knowing how many days it
 * rests on: a quantity habit logged mostly without values is not 100%, it is
 * unmeasured, and the two must not look alike.
 */
export function attainment(habit, { from, to }) {
  let total = 0;
  let sessions = 0;

  for (const date of eachDay(from, to)) {
    // A habit's history stops when it is archived; a day after that was not
    // lived, whatever a stray row might say.
    if (habit.archivedOn && date > habit.archivedOn) break;
    if (habit.logs.get(date) !== "done") continue;

    const value = habit.values?.get(date);
    if (value === undefined || value === null) continue;

    const target = resolveSchedule(habit.versions, habit.startDate, date)?.target_value;
    if (target === undefined || target === null) continue;

    total += Math.min(value / target, 1);
    sessions += 1;
  }

  return { sessions, rate: sessions === 0 ? null : total / sessions };
}
