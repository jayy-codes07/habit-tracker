/**
 * One habit's whole life — the screen this product did not have, and the
 * fullest expression of the instrument.
 *
 * habit_logs.note holds up to 1000 characters per habit per day, and until this
 * screen existed the only way to read one back was to know the date and open
 * that day. Months of writing were in the database and out of reach. So the
 * question this screen answers is "what happened with this one", and the answer
 * is a record, not a report card.
 *
 * Everything the visual language promises is visible here at once: the lifetime
 * sheet, a dashed CUT at every schedule version, the ruling going pecked across
 * a pause, an ink end-cap where the record stops, the annotation rule under the
 * channels, and the pen at today with blank paper running on ahead.
 *
 * What it shows, and the line it will not cross:
 *
 *   FACTS — when it started, what was asked of it and when that changed, when
 *   it was paused, when it was archived, what was done, what was written.
 *
 *   INTERPRETATION — kept to the one sentence under the name, which describes
 *   the habit's present state and nothing else.
 *
 *   NOTHING ELSE. There is no longest streak here, no best month, no record, no
 *   personal best, and none should be added. A count says what happened; a
 *   maximum is a high score in a game with one player, and the moment a screen
 *   carries one, "do not break the record" becomes a reason not to rest — in a
 *   product whose whole scoring model exists to make rest cost nothing.
 */
import { useState, type MouseEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { ErrorBox } from "../components/ErrorBox";
import { QUIET } from "../components/form";
import { Chevron } from "../components/icons";
import { Skeleton } from "../components/Skeleton";
import { HabitEditor } from "../features/habits/HabitEditor";
import { Legend } from "../features/habits/Legend";
import { useHabitHistory } from "../features/habits/queries";
import { Sheet, type Cut } from "../features/habits/Sheet";
import { useParkedScroller, useSheetCell } from "../features/habits/sheet-view";
import { scheduleWords, tally } from "../features/habits/verdict";
import { ApiError } from "../lib/api-client";
import { daysBetween, formatDateShort } from "../lib/dates";
import type { Habit, HistoryNote, HistoryPayload, IsoDate, Schedule } from "../types";

/** How long, in the largest unit that does not flatter or belittle it. */
function span(from: IsoDate, to: IsoDate): string {
  const days = daysBetween(from, to) + 1;
  if (days < 62) return `${days} ${days === 1 ? "day" : "days"}`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} months`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest === 0
    ? `${years} years`
    : `${years} ${years === 1 ? "year" : "years"}, ${rest} ${rest === 1 ? "month" : "months"}`;
}

const words = (schedule: Schedule, unit: string | null) =>
  scheduleWords(
    schedule.schedule_kind,
    schedule.schedule_days,
    schedule.weekly_target,
    schedule.target_value,
    unit,
  );

const DAY_LETTERS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/**
 * A version, in the few characters a 9px flag on the sheet can hold.
 *
 * Deliberately terser than scheduleWords: the stream below names every change
 * in full, so the flag only has to be enough to recognise the change by while
 * looking at the paper.
 */
function cutLabel(version: Schedule, previous: Schedule | undefined, first: boolean): string {
  if (version.schedule_kind === "paused") return "Paused";
  if (previous?.schedule_kind === "paused") return "Resumed";
  if (first) return "Start";
  if (version.schedule_kind === "weekly") return `${version.weekly_target}×/wk`;
  const days = [...(version.schedule_days ?? [])].sort((a, b) => a - b);
  if (days.length === 7) return "Daily";
  if (days.length === 5 && days.every((day) => day <= 5)) return "Weekdays";
  return days.map((day) => DAY_LETTERS[day - 1]).join(" ");
}

/**
 * The one interpretive sentence on the screen: where this habit stands now.
 *
 * One line in one grammar — what is being asked of it, then how long it has been
 * going — so that a paused habit reads as a variation on an active one rather
 * than as a different kind of thing.
 *
 * Facts only. No encouragement, no assessment, and no duration under a week:
 * "1 day" is not a span, it is a start date said twice.
 */
function stateLine(habit: Habit, today: IsoDate): string {
  if (habit.start_date > today) return `Starts ${formatDateShort(habit.start_date)}`;

  const last = habit.archived_on ?? today;
  const long = daysBetween(habit.start_date, last) + 1 >= 7;
  const began = formatDateShort(habit.start_date);

  if (habit.archived_on) {
    return long
      ? `Archived ${formatDateShort(habit.archived_on)} · kept ${span(
          habit.start_date,
          habit.archived_on,
        )} from ${began}`
      : `Archived ${formatDateShort(habit.archived_on)} · started ${began}`;
  }

  const kept = long ? `since ${began} · ${span(habit.start_date, last)}` : `since ${began}`;

  // `resumes_to`, not a guess: a paused version stores no days and no target, so
  // what it will come back as is not derivable from the version in force.
  if (habit.schedule?.schedule_kind === "paused") {
    const back = habit.resumes_to ? `, resuming as ${words(habit.resumes_to, habit.unit)}` : "";
    return `Paused since ${formatDateShort(habit.schedule.effective_from)}${back} · ${kept}`;
  }

  return habit.schedule ? `${words(habit.schedule, habit.unit)} · ${kept}` : kept;
}

/**
 * The flat tally. Counts, in the order they matter, with the zeroes left out —
 * and no rate. A rate is consistency, which has real rules about denominators
 * and belongs to /review.
 */
function tallyLine(data: HistoryPayload): string {
  /*
   * Only the days that have actually been lived.
   *
   * dayVerdict checks paused before future, deliberately: a paused habit's
   * remaining week should paint as "nothing is being asked" rather than as a
   * blank gap. The consequence is that those future cells decode as `paused`
   * too — so counting the whole string reported a habit paused this morning as
   * having five days of pause behind it. The domain rule is right; the
   * arithmetic had to stop at today.
   */
  const lived = daysBetween(data.start, data.today) + 1;
  const counts = tally(data.cells.slice(0, Math.max(0, lived)));
  const parts = [`${(counts.done ?? 0) + (counts.bonus ?? 0)} done`];
  if (counts.missed) parts.push(`${counts.missed} missed`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  if (counts.unlogged) parts.push(`${counts.unlogged} not logged`);
  // The one plural noun in the line, and a pause that started this morning is
  // exactly the case that shows it.
  if (counts.paused) {
    parts.push(`${counts.paused} ${counts.paused === 1 ? "day" : "days"} paused`);
  }
  return parts.join(" · ");
}

// --- the stream -------------------------------------------------------------

type Entry =
  | { date: IsoDate; kind: "note"; note: HistoryNote }
  | { date: IsoDate; kind: "event"; text: string };

/**
 * What happened, newest first: the days that were written on and the days the
 * habit itself changed, in one stream rather than two.
 *
 * One stream because the two explain each other — "I moved it to three days a
 * week" three entries above "this is working better" is the story, and two
 * separate lists make the reader hold a date in their head to find it. It also
 * means the page is never empty: a habit with nothing written still has a
 * beginning, its schedule changes and, if it has one, its ending.
 *
 * Schedule events are deliberately inert. setSchedule appends and refuses to
 * backdate, so a tap on one could only either lie about editing the past or
 * quietly write a new version — while a note goes to its own day, which is
 * where it can be fixed.
 */
function timeline(data: HistoryPayload, notes: HistoryNote[], complete: boolean): Entry[] {
  const habit = data.habit;
  const events: Entry[] = [];

  data.versions.forEach((version, index) => {
    const said = words(version, habit.unit);
    const previous = data.versions[index - 1];
    const text =
      index === 0
        ? `Started · ${said}`
        : previous?.schedule_kind === "paused" && version.schedule_kind !== "paused"
          ? `Resumed · ${said}`
          : version.schedule_kind === "paused"
            ? "Paused"
            : said;
    events.push({ date: version.effective_from, kind: "event", text });
  });

  if (habit.archived_on) events.push({ date: habit.archived_on, kind: "event", text: "Archived" });

  /*
   * Events are held back to the oldest note on screen while older notes are
   * still unread. Otherwise the whole schedule history — which arrives in one
   * piece, because there are only ever a handful of versions — would pile up at
   * the bottom of the first page, below writing it predates by months.
   */
  const floor = complete ? null : (notes[notes.length - 1]?.date ?? null);
  const kept = floor === null ? events : events.filter((event) => event.date >= floor);

  return [...notes.map((note): Entry => ({ date: note.date, kind: "note", note })), ...kept].sort(
    // Same day: the writing leads, and the change that made it possible follows.
    (a, b) => (a.date === b.date ? (a.kind === "note" ? -1 : 1) : a.date < b.date ? 1 : -1),
  );
}

function Stream({
  entries,
  unit,
  more,
  loading,
  onMore,
}: {
  entries: Entry[];
  unit: string | null;
  more: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  return (
    <section aria-labelledby="stream-heading">
      <h2 id="stream-heading" className="label text-ink border-baseline border-b pb-2">
        What happened
      </h2>

      {/*
       * The stream's rail continues the annotation rule on the sheet above it,
       * turned through ninety degrees: a filled tick is a change to the habit,
       * a hollow one a day that was written on. Same rail, same indent, neither
       * promoted.
       */}
      <ul className="border-grid mt-3 max-w-[62ch] border-l">
        {entries.map((entry) => (
          <li key={`${entry.kind}-${entry.date}`} className="relative py-3 pl-5">
            <span
              aria-hidden="true"
              className={`absolute top-[1.35rem] -left-px ${
                entry.kind === "event" ? "bg-ink h-[3px] w-2.5" : "bg-baseline h-px w-2.5"
              }`}
            />
            {entry.kind === "note" ? (
              <>
                <Link
                  to={`/day/${entry.date}`}
                  className="hover:text-ink text-muted font-mono text-meta inline-flex min-h-7 items-center gap-1.5"
                >
                  {formatDateShort(entry.date)}
                  {entry.note.status !== "done" && ` · ${entry.note.status}`}
                  {unit && entry.note.value !== null && ` · ${entry.note.value} ${unit}`}
                  <Chevron />
                </Link>
                <p className="text-read mt-1 font-serif">{entry.note.note}</p>
              </>
            ) : (
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1">
                <span className="text-muted font-mono text-meta">
                  {formatDateShort(entry.date)}
                </span>
                <span className="label text-ink">{entry.text}</span>
              </p>
            )}
          </li>
        ))}
      </ul>

      {more && (
        <button type="button" onClick={onMore} disabled={loading} className={`${QUIET} mt-5`}>
          {loading ? "Loading" : "Older"}
        </button>
      )}
    </section>
  );
}

// --- the screen -------------------------------------------------------------

const HistorySkeleton = () => (
  <div className="grid gap-4 pt-2">
    <Skeleton className="h-24" />
    <Skeleton className="h-5 w-52" />
    <Skeleton className="h-32" />
  </div>
);

export default function HabitHistory() {
  const { id } = useParams();
  const navigate = useNavigate();
  const query = useHabitHistory(id!);
  const [editing, setEditing] = useState(false);

  const first = query.data?.pages[0];
  const notes = query.data?.pages.flatMap((page) => page.notes) ?? [];
  const complete = !query.hasNextPage;

  const entries = first ? timeline(first, notes, complete) : [];
  const gone = query.error instanceof ApiError && query.error.status === 404;

  const cell = useSheetCell();
  const scroller = useParkedScroller([first?.start, first?.weeks, cell]);

  const pick = (event: MouseEvent<HTMLDivElement>) => {
    const date = (event.target as HTMLElement).closest<HTMLElement>("[data-date]")?.dataset.date;
    if (date) navigate(`/day/${date}`);
  };

  /*
   * The cuts, with labels dropped where two versions land too close together to
   * set one. The cut itself is always drawn — losing a label costs nothing,
   * because the stream below names every change by date.
   */
  const cuts: Cut[] = [];
  if (first) {
    let lastLabelled = -Infinity;
    first.versions.forEach((version, index) => {
      const week = Math.floor(daysBetween(first.start, version.effective_from) / 7);
      const label = cutLabel(version, first.versions[index - 1], index === 0);
      const room = Math.ceil((label.length * 5.5) / (cell + 2));
      const fits = week - lastLabelled >= room;
      if (fits) lastLabelled = week;
      cuts.push({ date: version.effective_from, label: fits ? label : null });
    });
  }

  /*
   * One tick per week that was written on — but only across the pages that have
   * actually loaded. The rule stops at an open bracket where older notes have
   * not been asked for yet, because a rule running the whole width would be
   * claiming to have read a record it has not. Pressing "Older" extends it.
   */
  const annotations = (() => {
    if (!first) return null;
    const perWeek = new Map<number, number>();
    let earliest = first.weeks;
    for (const note of notes) {
      const week = Math.floor(daysBetween(first.start, note.date) / 7);
      if (week < 0 || week >= first.weeks) continue;
      perWeek.set(week, (perWeek.get(week) ?? 0) + 1);
      earliest = Math.min(earliest, week);
    }
    if (perWeek.size === 0 && complete) return null;
    return { perWeek, from: complete ? 0 : Math.max(0, earliest), complete };
  })();

  return (
    <div className="mx-auto w-full max-w-[84rem] px-4 pb-16 sm:px-6 lg:px-8">
      <header className="pt-6 pb-7 sm:pt-10">
        <Link
          to="/habits"
          className="label text-muted hover:text-ink inline-flex min-h-9 items-center gap-1.5"
        >
          <Chevron className="rotate-180" />
          Habits
        </Link>

        {first && (
          <>
            <h1 className="mt-3 flex items-stretch gap-4">
              <span
                aria-hidden="true"
                className="w-[3px] shrink-0"
                style={{
                  background: `var(--c-${first.habit.color_token})`,
                  opacity: first.habit.archived_on ? 0.35 : 1,
                }}
              />
              <span className="font-serif text-[2.25rem] leading-[1.05] tracking-[-0.02em] sm:text-[3rem] lg:text-[3.5rem]">
                {first.habit.name}
              </span>
            </h1>

            {/* Registers derived from dates already on the payload — an
                instrument says where in the run you are, and this costs the
                server nothing. */}
            <p className="label text-muted mt-4 flex flex-wrap gap-x-6 gap-y-1.5">
              <Reg k="since" v={formatDateShort(first.habit.start_date)} />
              <Reg
                k="span"
                v={`${daysBetween(first.habit.start_date, first.habit.archived_on ?? first.today) + 1} days`}
              />
              <Reg k="sheet" v={`${first.weeks}w`} />
              <Reg k="versions" v={first.versions.length} />
            </p>
            <p className="text-muted text-read mt-3 max-w-[62ch] font-serif">
              {stateLine(first.habit, first.today)}
            </p>
          </>
        )}
      </header>

      {gone ? (
        /* Deleting a habit from the editor above leaves this page pointing at
           something that no longer exists, and a Retry button on a 404 only
           offers to fail again. */
        <section>
          <p className="font-serif text-name">This habit is gone.</p>
          <Link
            to="/habits"
            className="label text-muted hover:text-ink mt-2 inline-flex min-h-11 items-center gap-1.5"
          >
            Back to habits
            <Chevron />
          </Link>
        </section>
      ) : query.isError && !first ? (
        <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
      ) : !first ? (
        <HistorySkeleton />
      ) : (
        <>
          {/* Full width, above the split. The sheet is the one thing on this
              page that genuinely wants a wide screen — a whole year of it is
              legible across 1000px and illegible across 300. */}
          {/* The same key as Pattern, above the same drawing: one vocabulary,
              taught wherever it is spoken. */}
          <div className="border-baseline mb-7 border-b pb-5">
            <Legend cells={first.cells} />
          </div>

          <div ref={scroller} onClick={pick} className="overflow-x-auto pb-1">
            <Sheet
              cells={first.cells}
              start={first.start}
              weeks={first.weeks}
              today={first.today}
              tint={`var(--c-${first.habit.color_token})`}
              cell={cell}
              gap={2}
              cuts={cuts}
              archivedOn={first.habit.archived_on}
              annotations={annotations}
            />
          </div>
          {annotations && (
            <p className="label text-muted mt-1">
              days written{annotations.complete ? "" : " · loaded so far"}
            </p>
          )}

          {/* The measure and the rail, side by side and left-aligned — not a
              1fr column with the rail pinned to the far edge, which put 180px
              of nothing between the sentences and the thing that acts on them.
              A document, not a dashboard. */}
          <main className="mt-10 md:grid md:grid-cols-[minmax(0,62ch)_15rem] md:items-start md:gap-x-11">
            {/* Source order is the phone's: the tally and the one way in to
                changing anything sit above the stream, at a fixed place near
                the top, whatever the habit's history weighs. On a wide screen
                the same two move into the rail and stay in view. */}
            <div className="md:col-start-2 md:row-start-1 md:sticky md:top-6">
              <p className="label text-muted leading-[1.6]">{tallyLine(first)}</p>
              <div className="mt-4">
                <button type="button" onClick={() => setEditing(true)} className={QUIET}>
                  Edit habit
                </button>
              </div>
              {/* One editor, one owner. Pausing, archiving, restoring, renaming
                  and rescheduling all live in that dialog already, and a second
                  set of buttons here would be a second place for the rules
                  about deferred schedule changes to be got wrong. */}
            </div>

            <div className="mt-10 md:col-start-1 md:row-start-1 md:mt-0">
              <Stream
                entries={entries}
                unit={first.habit.unit}
                more={query.hasNextPage}
                loading={query.isFetchingNextPage}
                onMore={() => void query.fetchNextPage()}
              />
            </div>
          </main>
        </>
      )}

      {editing && first && <HabitEditor habit={first.habit} onClose={() => setEditing(false)} />}
    </div>
  );
}

const Reg = ({ k, v }: { k: string; v: string | number }) => (
  <span className="inline-flex items-baseline gap-2">
    {k}
    <span className="font-mono text-meta text-ink">{v}</span>
  </span>
);
