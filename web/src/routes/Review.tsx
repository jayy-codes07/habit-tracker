/**
 * The monthly review — what the month actually amounted to, read at month
 * scale on the same instrument.
 *
 * Pattern shows the shape of a month; this says what it came to. Consistency
 * and the streak answer different questions and are both reported, which is the
 * server's rule, not a layout preference: a streak says "am I going right now",
 * consistency says "how did the month go", and one good week should not be
 * allowed to disguise a bad month.
 *
 * Nothing is scored here. `consistency` arrives computed — skipped days have
 * already left the denominator, paused days never entered it, a weekly week
 * contributed its target — and this screen only formats it. Three traps in the
 * payload are handled and commented below: a null rate, `done_of`, and
 * `archived_on`, which is only about this month when it falls on or before
 * `end` — a habit archived later was alive for all of the month being read.
 *
 * The streak figure is bounded by the window the server loaded, so what it is
 * called changes with the month; see streakLabel().
 *
 * There is no maximum on this payload and there is not meant to be. The product
 * states what happened; it does not keep records. A "best" is a high score in a
 * game with one player, and once a screen carries one, deciding to rest costs
 * something — in an app whose whole scoring model exists to make rest cost
 * nothing. Counts, states and rates are facts about a month and all stay: done,
 * missed, skipped, not logged, paused, consistency, attainment, and the current
 * streak, which says where you are rather than ranking you against where you
 * have been.
 *
 * `longest_streak` used to ride along here, computed per habit on every load and
 * read by nothing. It was removed rather than left as a field the interface is
 * forbidden to use — the comment justifying it claimed the export needed it,
 * and the export is raw rows only and never carried it.
 */
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { ErrorBox } from "../components/ErrorBox";
import { ICON_BUTTON } from "../components/form";
import { Chevron } from "../components/icons";
import { Skeleton } from "../components/Skeleton";
import { useSaveMonthJournal } from "../features/journal/queries";
import { useCompare, useReview } from "../features/overview/queries";
import {
  addMonths,
  browserToday,
  daysBetween,
  formatDateLong,
  formatDateShort,
  formatMonthLong,
  isoWeekday,
  monthOf,
} from "../lib/dates";
import type { IsoDate, IsoMonth, JournalEntry, MonthFacts, ReviewHabit } from "../types";

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

/**
 * When the streak figures were taken.
 *
 * The server measures both to the end of the window the review loaded, so they
 * are as of today only for the current month; for a past month they are the
 * streak that month finished on. An archived habit stops earlier still — the
 * walk is capped at its archive date — so once it has retired, neither of the
 * other two words is true.
 */
const streakLabel = (retired: boolean, isThisMonth: boolean) =>
  retired ? "Streak when archived" : isThisMonth ? "Streak now" : "Streak at month end";

/**
 * How close the measured sessions came, for a habit that measures.
 *
 * Deliberately a separate line from the consistency figure, and deliberately
 * worded so the two cannot be read as the same claim: consistency asks whether
 * you showed up as often as you said you would, this asks how close you got when
 * you did. A habit can honestly be 100% on the first and 60% on the second, and
 * a reader who takes one for the other has been misled by the layout.
 *
 * The session count travels with the percentage, always. A rate over two
 * sessions and a rate over twenty are different claims, and a quantity habit
 * logged mostly without values would otherwise read as a confident number
 * resting on almost nothing.
 *
 * Null for every binary habit — nothing here may invent a metric for a habit
 * that never measured anything.
 */
function attainmentLine(habit: ReviewHabit): string | null {
  if (!habit.unit) return null;
  if (habit.attainment === null) return "nothing measured";

  const sessions = habit.attainment_of === 1 ? "1 session" : `${habit.attainment_of} sessions`;
  return `${percent(habit.attainment)}% of target over ${sessions}`;
}

function HabitRow({
  habit,
  end,
  isThisMonth,
}: {
  habit: ReviewHabit;
  end: IsoDate;
  isThisMonth: boolean;
}) {
  const tally = tallyLine(habit);
  const attainment = attainmentLine(habit);

  /*
   * Against the month's end, never against today: a habit archived after this
   * month was alive for all of it, and that month keeps reading the way it was
   * lived. The server has already dropped anything archived before the month
   * began, so this is exactly "retired within the month on screen".
   */
  const retiredOn =
    habit.archived_on !== null && habit.archived_on <= end ? habit.archived_on : null;
  const retired = retiredOn !== null;

  const tint = `var(--c-${habit.color_token})`;
  const rate = retired || habit.consistency === null ? null : habit.consistency;

  return (
    /*
     * The row's own floor rule doubles as its consistency bar: it fills from the
     * left to the rate, in the habit's colour. No bar widget, no card, no chart
     * — the measurement is drawn on the line that belongs to it, and the figure
     * naming it sits beside it in the register.
     */
    <li className="relative py-4">
      <span aria-hidden="true" className="bg-tray absolute inset-x-0 bottom-0 h-0.5" />
      {rate !== null && (
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-0 h-0.5"
          style={{ width: `${percent(rate)}%`, background: tint }}
        />
      )}
      {/* Where the record stops, drawn on the rule it stops on. */}
      {retired && (
        <span aria-hidden="true" className="bg-ink absolute bottom-0 left-0 h-2.5 w-px" />
      )}

      <div className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="w-[3px] shrink-0 self-stretch"
          style={{ background: tint, opacity: retired ? 0.35 : 1 }}
        />

        <div className="min-w-0 flex-1">
          <h3 className={`font-serif text-name ${retired ? "text-muted" : ""}`}>{habit.name}</h3>
          <p className="label text-muted mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
            {tally && <span>{tally}</span>}
            <span>
              {streakLabel(retired, isThisMonth)}{" "}
              <span className="font-mono text-meta text-ink">{habit.current_streak}</span>
            </span>
            {attainment && <span>{attainment}</span>}
          </p>
        </div>

        <div className="shrink-0 text-right">
          {/*
           * A habit retired mid-month spends its last days unlogged, so its rate
           * over the stub of month it lived is near zero — and a month that reads
           * "0% consistency" against a habit you deliberately put away is an
           * accusation, not a record. The tally on the left still says exactly
           * what happened; this says why it stopped.
           */}
          {retiredOn ? (
            <>
              <p className="font-mono text-reg text-muted leading-none">
                {formatDateShort(retiredOn)}
              </p>
              <p className="label text-muted mt-2">archived</p>
            </>
          ) : habit.consistency === null ? (
            <>
              <p className="font-mono text-pct text-muted leading-none">—</p>
              <p className="label text-muted mt-2">nothing asked</p>
            </>
          ) : (
            <>
              <p className="font-mono text-pct leading-none font-medium tracking-[-0.04em]">
                {percent(habit.consistency)}
                <span className="text-meta ml-0.5 font-normal">%</span>
              </p>
              <p className="label text-muted mt-2">consistency</p>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * The month as an axis, with one annotation tick under every day that was
 * written on.
 *
 * Honest by construction: `journal.days` IS that list, so nothing is inferred
 * and nothing is asked of the server. It is the same language the habit history
 * screen uses under its sheet, at month scale — and it is the only place on this
 * screen where the month has a shape rather than a total.
 */
function MonthAxis({
  start,
  end,
  today,
  written,
}: {
  start: IsoDate;
  end: IsoDate;
  today: IsoDate | null;
  written: Set<IsoDate>;
}) {
  const span = daysBetween(start, end);
  if (span <= 0) return null;

  const days = Array.from({ length: span + 1 }, (_unused, index) => ({
    date: `${start.slice(0, 8)}${String(index + 1).padStart(2, "0")}`,
    left: `${(index / span) * 100}%`,
  }));

  return (
    <div aria-hidden="true" className="max-w-[38rem]">
      <div className="border-baseline relative h-8 border-b">
        {days.map(({ date, left }) => {
          const monday = isoWeekday(date) === 1;
          const future = today !== null && date > today;
          return (
            <span
              key={date}
              className={`absolute bottom-0 w-px ${monday ? "bg-baseline" : "bg-faint"} ${
                future ? "opacity-40" : ""
              }`}
              style={{ left, height: monday ? 10 : 5 }}
            />
          );
        })}
        {today !== null && today >= start && today <= end && (
          <span
            className="absolute bottom-0 h-0 w-0"
            style={{
              left: `${(daysBetween(start, today) / span) * 100}%`,
              transform: "translateX(-50%)",
              borderLeft: "5px solid transparent",
              borderRight: "5px solid transparent",
              borderBottom: "8px solid var(--c-ink)",
            }}
          />
        )}
      </div>
      <div className="relative h-2.5">
        {days
          .filter(({ date }) => written.has(date))
          .map(({ date, left }) => (
            <span key={date} className="bg-baseline absolute top-0 h-2 w-0.5" style={{ left }} />
          ))}
      </div>
    </div>
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
      <div className="border-baseline flex items-baseline justify-between gap-3 border-b pb-2">
        <h2 id="reflection-heading" className="label text-ink">
          Reflection
        </h2>
        <p aria-live="polite" className="label text-muted">
          {save.isPending ? "saving" : dirty ? "unsaved" : ""}
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
        className="ruled placeholder:text-faint mt-3 w-full max-w-[56ch] resize-y"
      />

      {save.isError && (
        <p role="alert" className="text-warn text-meta mt-1">
          {(save.error as Error).message}
        </p>
      )}
    </section>
  );
}

/**
 * The days that were written in, as a way back into them.
 *
 * It used to render last, under the percentages, the tasks and the reflection —
 * so the one part of the month that is in the person's own words came after
 * three blocks of the machine's. It now sits directly under the habits, above
 * everything else the month has to say, and an empty month says so rather than
 * vanishing: a section that disappears teaches nobody that it exists.
 */
function DaysWritten({ days }: { days: JournalEntry[] }) {
  return (
    <section aria-labelledby="days-heading">
      <h2 id="days-heading" className="label text-ink border-baseline border-b pb-2">
        {days.length === 0
          ? "Nothing written"
          : days.length === 1
            ? "One day written"
            : `${days.length} days written`}
      </h2>
      {days.length === 0 && (
        <p className="text-muted mt-3 max-w-sm">
          The box at the bottom of any day keeps what you write there. It comes back here, and on
          the habit it was about.
        </p>
      )}
      <ul className="border-grid mt-3 max-w-[62ch] border-l">
        {days.map((day) => (
          <li key={day.date} className="relative py-3 pl-5">
            <span
              aria-hidden="true"
              className="bg-baseline absolute top-[1.35rem] -left-px h-px w-2.5"
            />
            <Link
              to={`/day/${day.date}`}
              className="hover:text-ink text-muted font-mono text-meta inline-flex min-h-7 items-center gap-1.5"
            >
              {formatDateLong(day.date)}
              <Chevron />
            </Link>
            <p className="text-read mt-1 font-serif">{day.entry}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// --- the same month, a year apart -------------------------------------------

/**
 * One measure, in both years. Counts only.
 *
 * `previous` is written FIRST, on the left, because time runs left to right
 * here as it does on every sheet in this product. That is also the quiet reason
 * there is no arrow: two figures in chronological order are a record, and the
 * same two with a direction stamped between them are a verdict on a year of
 * someone's life.
 */
const MEASURES: { key: string; label: string; of: (facts: MonthFacts) => number | boolean }[] = [
  { key: "written", label: "days written", of: (facts) => facts.journal_days },
  { key: "reflection", label: "reflection", of: (facts) => facts.reflection },
  { key: "habits", label: "habits", of: (facts) => facts.habits },
  // Logged days, not the verdicts above — see MonthFacts. "not logged" cannot
  // appear here: it is a judgement about a schedule, and a schedule that has
  // since been edited would change what a year-old month is said to have done.
  { key: "done", label: "days done", of: (facts) => facts.habit_days.done },
  { key: "missed", label: "days missed", of: (facts) => facts.habit_days.missed },
  { key: "skipped", label: "days skipped", of: (facts) => facts.habit_days.skipped },
  { key: "tasks", label: "tasks done", of: (facts) => facts.tasks.completed },
  { key: "problems", label: "problems", of: (facts) => facts.leetcode },
];

/** A boolean is a fact too, and "—" is how this product says none. */
const figure = (value: number | boolean) =>
  typeof value === "boolean" ? (value ? "yes" : "—") : String(value);

/**
 * The same month, a year ago, beside this one.
 *
 * It is here rather than on its own screen because it is a reading of a month,
 * and /review is where a month is read. It is small and it is at the foot for
 * the same reason: the month you lived is the subject, and last year is context
 * for it.
 *
 * It says nothing when there is no record from a year ago. A column of zeroes
 * reads as a year that went badly, which is the one thing a month with no data
 * in it definitely does not mean.
 */
function YearAgo({ month }: { month: IsoMonth }) {
  const query = useCompare(month);
  const data = query.data;

  // Silent while loading and silent on failure: this is context beside the
  // month, and an error box for it would put a failure notice on a screen whose
  // actual subject loaded perfectly well.
  if (!data || !data.previous.present) return null;

  return (
    <section aria-labelledby="year-ago-heading" className="mt-10">
      <h2 id="year-ago-heading" className="label text-ink border-baseline border-b pb-2">
        A year ago
      </h2>

      <table className="mt-3 w-full">
        <caption className="sr-only">
          {formatMonthLong(data.previous.month)} and {formatMonthLong(month)}, side by side
        </caption>
        <thead>
          <tr className="label text-muted">
            <th scope="col" className="w-full text-left font-normal">
              <span className="sr-only">Measure</span>
            </th>
            <th scope="col" className="px-2 pb-1 text-right font-normal whitespace-nowrap">
              {data.previous.month.slice(0, 4)}
            </th>
            <th scope="col" className="pb-1 text-right font-normal whitespace-nowrap">
              {month.slice(0, 4)}
            </th>
          </tr>
        </thead>
        <tbody>
          {MEASURES.map((measure) => (
            <tr key={measure.key} className="border-baseline border-t">
              <th scope="row" className="label text-muted py-1.5 text-left font-normal">
                {measure.label}
              </th>
              <td className="font-mono text-meta text-muted px-2 py-1.5 text-right">
                {figure(measure.of(data.previous))}
              </td>
              {/* The month on screen takes ink; the year behind it does not.
                  That is the only distinction drawn between them, and it is
                  about which one you are reading, not which one did better. */}
              <td className="font-mono text-meta text-ink py-1.5 text-right">
                {figure(measure.of(data.current))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  const written = new Set((data?.journal.days ?? []).map((day) => day.date));

  /*
   * The month is a NAME, so it is set in the serif while the register carries
   * the figures — which keeps the rule that the mono face means numbers, and
   * gives the one reflective screen a voice of its own.
   */
  const identity = (
    <div>
      <p className="label text-muted">Review · {isThisMonth ? "this month" : "looking back"}</p>
      <h1 className="font-serif mt-2 text-[2.5rem] leading-none tracking-[-0.02em] lg:text-[3.25rem]">
        {formatMonthLong(month).split(" ")[0]}
      </h1>
      <p className="font-mono text-reg text-muted mt-2">{month.slice(0, 4)}</p>
      {data && (
        <p className="label text-muted mt-4 flex flex-wrap gap-x-5 gap-y-1">
          <Reg k="days" v={`${data.start.slice(8)}–${data.end.slice(8)}`} />
          <Reg k="written" v={data.journal.days.length} />
          <Reg k="tasks done" v={data.tasks.completed} />
        </p>
      )}
    </div>
  );

  const steppers = (
    <nav aria-label="Change month" className="flex shrink-0 items-center gap-2">
      {!isThisMonth && (
        <button
          type="button"
          onClick={() => navigate(`/review/${thisMonth}`)}
          className="label min-h-11 px-1"
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
  );

  return (
    <div className="mx-auto w-full max-w-[84rem] px-4 pb-16 sm:px-6 lg:px-8">
      {/*
       * ONE identity column, moved by grid placement rather than duplicated
       * behind a breakpoint: two copies duplicate every id on the page, and the
       * hidden one comes first in document order, so `h1` resolves to something
       * that is not on screen.
       */}
      <div
        className={`transition-opacity lg:grid lg:grid-cols-[15.5rem_minmax(0,38rem)_minmax(0,17rem)] lg:items-start lg:gap-x-11 lg:pt-16 xl:gap-x-14 ${
          query.isPlaceholderData ? "opacity-50" : "opacity-100"
        }`}
      >
        <header className="pt-6 pb-7 sm:pt-10 lg:col-start-1 lg:row-start-1 lg:pt-0 lg:pb-0">
          {identity}
          <div className="mt-5 flex">{steppers}</div>
        </header>

        {query.isError && !data ? (
          <div className="lg:col-start-2 lg:row-start-1">
            <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
          </div>
        ) : !data ? (
          <div className="lg:col-start-2 lg:row-start-1">
            <ReviewSkeleton />
          </div>
        ) : (
          <main className="contents">
            <div className="lg:col-start-2 lg:row-start-1">
              <MonthAxis
                start={data.start}
                end={data.end}
                today={isThisMonth ? browserToday() : null}
                written={written}
              />
              {/* The count belongs to the list further down, which is headed with
                  it. Here the caption only has to name what the ticks are. */}
              <p className="label text-muted mt-1.5">days written</p>

              <section aria-labelledby="habits-heading" className="mt-8">
                <h2 id="habits-heading" className="sr-only">
                  Habits
                </h2>
                {data.habits.length === 0 ? (
                  <>
                    <p className="font-serif text-name">Nothing tracked this month.</p>
                    <p className="text-muted mt-2 max-w-sm">
                      A month with no habits in it has nothing to review.
                    </p>
                  </>
                ) : (
                  <ul>
                    {data.habits.map((habit) => (
                      <HabitRow
                        key={habit.id}
                        habit={habit}
                        end={data.end}
                        isThisMonth={isThisMonth}
                      />
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <div className="mt-12 lg:col-start-3 lg:row-start-1 lg:mt-0">
              <Reflection key={month} month={month} entry={data.journal.month} />

              <section aria-labelledby="tasks-heading" className="mt-10">
                <h2 id="tasks-heading" className="label text-ink border-baseline border-b pb-2">
                  Tasks
                </h2>
                <p className="label text-muted mt-3 flex flex-wrap gap-x-5 gap-y-1">
                  {data.tasks.completed === 0 && data.tasks.created === 0 ? (
                    <span>None either way.</span>
                  ) : (
                    <>
                      <Reg k="completed" v={data.tasks.completed} />
                      <Reg k="created" v={data.tasks.created} />
                    </>
                  )}
                </p>
              </section>

              <YearAgo month={month} />
            </div>

            <div className="mt-12 lg:col-start-2 lg:row-start-2 lg:mt-14">
              <DaysWritten days={data.journal.days} />
            </div>
          </main>
        )}
      </div>
    </div>
  );
}

const Reg = ({ k, v }: { k: string; v: string | number }) => (
  <span className="inline-flex items-baseline gap-2">
    {k}
    <span className="font-mono text-meta text-ink">{v}</span>
  </span>
);
