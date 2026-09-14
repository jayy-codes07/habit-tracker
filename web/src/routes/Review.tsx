/**
 * The monthly review — what the month actually amounted to.
 *
 * The grid shows the shape of a month; this says what it came to. Consistency
 * and the streak answer different questions and are both reported, which is the
 * server's rule, not a layout preference: a streak says "am I going right now",
 * consistency says "how did the month go", and one good week should not be
 * allowed to disguise a bad month.
 *
 * Nothing is scored here. `consistency` arrives computed — skipped days have
 * already left the denominator, paused days never entered it, a weekly week
 * contributed its target — and this screen only formats it. Two traps in the
 * payload are handled and commented below: a null rate, and `done_of`.
 */
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { ErrorBox } from "../components/ErrorBox";
import { Chevron } from "../components/icons";
import { Skeleton } from "../components/Skeleton";
import { useSaveMonthJournal } from "../features/journal/queries";
import { useReview } from "../features/overview/queries";
import { addMonths, browserToday, formatDateLong, formatMonthLong, monthOf } from "../lib/dates";
import type { IsoMonth, JournalEntry, ReviewHabit } from "../types";

const ICON_BUTTON =
  "border-line-strong hover:bg-raised text-ink grid h-11 w-11 place-items-center rounded-lg border transition-colors disabled:opacity-30 disabled:hover:bg-transparent";

/**
 * A rate as a whole number, without ever flattering it. 0.996 is not a perfect
 * month and must not print as 100%, and a month with something done in it must
 * not print as 0% — so the ends are reserved for the values that earn them.
 */
function percent(rate: number): number {
  if (rate >= 1) return 100;
  if (rate <= 0) return 0;
  return Math.min(99, Math.max(1, Math.round(rate * 100)));
}

/**
 * The month in the vocabulary the rest of the app uses — Done, Extra, Missed,
 * Not logged, Skipped, Paused — with the zeroes left out. A month that went
 * well should read as one short line, not a table of noughts.
 */
function tallyLine(habit: ReviewHabit): string {
  const parts: string[] = [];
  if (habit.done) parts.push(`${habit.done} done`);
  if (habit.bonus) parts.push(`${habit.bonus} extra`);
  if (habit.missed) parts.push(`${habit.missed} missed`);
  if (habit.unlogged) parts.push(`${habit.unlogged} not logged`);
  if (habit.skipped) parts.push(`${habit.skipped} skipped`);
  if (habit.paused) parts.push(`${habit.paused} paused`);
  return parts.join(" · ");
}

function HabitRow({ habit }: { habit: ReviewHabit }) {
  const tally = tallyLine(habit);

  return (
    <li className="border-line/70 flex items-start gap-3 border-b py-3 last:border-b-0">
      <span
        aria-hidden="true"
        className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: `var(--c-${habit.color_token})` }}
      />

      <div className="min-w-0 flex-1">
        <h3 className="text-row font-medium">{habit.name}</h3>
        {tally && <p className="text-meta text-muted">{tally}</p>}
        {/* Neither streak is bounded by the month on the server, so neither is
            described as if it were. */}
        <p className="text-meta text-muted tabular">
          Streak now {habit.current_streak} · best {habit.longest_streak}
        </p>
      </div>

      <div className="shrink-0 text-right">
        {habit.consistency === null ? (
          <>
            <p className="text-section text-muted tabular leading-none">—</p>
            <p className="text-micro text-muted mt-1">nothing asked</p>
          </>
        ) : (
          <>
            <p className="text-section tabular leading-none font-semibold">
              {percent(habit.consistency)}
              <span className="text-meta font-normal">%</span>
            </p>
            <p className="text-micro text-muted mt-1">consistency</p>
          </>
        )}
      </div>
    </li>
  );
}

// --- the month's own writing ------------------------------------------------

/**
 * Keyed on the month by its caller, so stepping months restarts the box from
 * that month's reflection rather than carrying the last one over. Saves on
 * blur, as the day's note does.
 */
function Reflection({ month, entry }: { month: IsoMonth; entry: JournalEntry | null }) {
  const saved = entry?.entry ?? "";
  const [text, setText] = useState(saved);
  const save = useSaveMonthJournal(month);
  const dirty = text.trim() !== saved;

  return (
    <section aria-labelledby="reflection-heading">
      <div className="flex items-baseline justify-between gap-3 pb-1">
        <h2 id="reflection-heading" className="text-section font-semibold tracking-[-0.01em]">
          Reflection
        </h2>
        <p aria-live="polite" className="text-meta text-muted">
          {save.isPending ? "Saving…" : dirty ? "Unsaved" : ""}
        </p>
      </div>

      <textarea
        value={text}
        rows={5}
        maxLength={10_000}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => dirty && save.mutate(text)}
        placeholder="What did this month amount to?"
        aria-label={`Reflection for ${formatMonthLong(month)}`}
        className="border-line bg-surface text-field focus:border-line-strong placeholder:text-muted w-full max-w-[66ch] resize-y rounded-xl border px-3.5 py-3 font-serif leading-relaxed outline-none"
      />

      {save.isError && (
        <p role="alert" className="text-warn text-meta mt-1">
          {(save.error as Error).message}
        </p>
      )}
    </section>
  );
}

/** The days that were written in, as a way back into them. */
function DaysWritten({ days }: { days: JournalEntry[] }) {
  if (days.length === 0) return null;

  return (
    <section aria-labelledby="days-heading">
      <h2 id="days-heading" className="text-section pb-1 font-semibold tracking-[-0.01em]">
        {days.length === 1 ? "One day written" : `${days.length} days written`}
      </h2>
      <ul className="max-w-[66ch]">
        {days.map((day) => (
          <li key={day.date} className="border-line/70 border-b py-3 last:border-b-0">
            <Link
              to={`/day/${day.date}`}
              className="hover:text-ink text-muted text-meta inline-flex min-h-7 items-center gap-1"
            >
              {formatDateLong(day.date)}
              <Chevron />
            </Link>
            <p className="font-serif leading-relaxed">{day.entry}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- the screen -------------------------------------------------------------

const ReviewSkeleton = () => (
  <div className="grid gap-3 pt-2">
    {[0, 1, 2, 3].map((row) => (
      <Skeleton key={row} className="h-16" />
    ))}
  </div>
);

export default function Review() {
  const { month: param } = useParams();
  const navigate = useNavigate();

  /*
   * The browser's clock picks the opening month, which is the one sanctioned
   * use of it (see browserToday). Unlike /day there is no server `today` in
   * this payload to correct against — but a month is only ambiguous for a few
   * hours at a boundary, and the stepper recovers it in one tap, where a wrong
   * *day* would have quietly mislogged something.
   */
  const month = param ?? monthOf(browserToday());
  const thisMonth = monthOf(browserToday());

  const query = useReview(month);
  const data = query.data;
  const isThisMonth = month === thisMonth;

  const go = (delta: number) => navigate(`/review/${addMonths(month, delta)}`);

  return (
    <div className="mx-auto w-full max-w-[68rem] px-4 pb-20 sm:px-6 lg:px-8">
      <header className="pt-5 pb-7 sm:pt-8 lg:max-w-[46rem]">
        <div className="flex items-center justify-between gap-3">
          <p className="text-meta text-muted">{isThisMonth ? "This month" : "Looking back"}</p>

          <nav aria-label="Change month" className="flex shrink-0 items-center gap-1.5">
            {!isThisMonth && (
              <button
                type="button"
                onClick={() => navigate(`/review/${thisMonth}`)}
                className="border-line-strong hover:bg-raised text-meta min-h-11 rounded-lg border px-3 font-medium"
              >
                This month
              </button>
            )}
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => go(-1)}
              className={ICON_BUTTON}
            >
              <Chevron className="rotate-180" />
            </button>
            <button
              type="button"
              aria-label="Next month"
              disabled={month >= thisMonth}
              onClick={() => go(1)}
              className={ICON_BUTTON}
            >
              <Chevron />
            </button>
          </nav>
        </div>

        <h1 className="font-serif text-date mt-1 tracking-[-0.015em]">{formatMonthLong(month)}</h1>
      </header>

      {query.isError && !data ? (
        <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
      ) : !data ? (
        <ReviewSkeleton />
      ) : (
        <div
          className={`transition-opacity lg:grid lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start lg:gap-x-12 xl:gap-x-16 ${
            query.isPlaceholderData ? "opacity-50" : "opacity-100"
          }`}
        >
          <main className="contents">
            <div className="lg:col-start-1 lg:row-start-1">
              <section aria-labelledby="habits-heading">
                <h2 id="habits-heading" className="sr-only">
                  Habits
                </h2>
                {data.habits.length === 0 ? (
                  <>
                    <p className="text-row">Nothing tracked this month.</p>
                    <p className="text-muted mt-1 max-w-sm">
                      A month with no habits in it has nothing to review.
                    </p>
                  </>
                ) : (
                  <ul>
                    {data.habits.map((habit) => (
                      <HabitRow key={habit.id} habit={habit} />
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <div className="mt-10 lg:col-start-2 lg:row-start-1 lg:mt-0">
              <section aria-labelledby="tasks-heading">
                <h2
                  id="tasks-heading"
                  className="text-section pb-1 font-semibold tracking-[-0.01em]"
                >
                  Tasks
                </h2>
                <p className="text-muted tabular">
                  {data.tasks.completed === 0 && data.tasks.created === 0
                    ? "None either way."
                    : `${data.tasks.completed} completed · ${data.tasks.created} created`}
                </p>
              </section>
            </div>

            <div className="mt-10 lg:col-start-1 lg:row-start-2 lg:mt-12">
              <Reflection key={month} month={month} entry={data.journal.month} />
            </div>

            <div className="mt-10 lg:col-start-1 lg:row-start-3 lg:mt-12">
              <DaysWritten days={data.journal.days} />
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
