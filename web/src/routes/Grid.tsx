/**
 * The consistency grid — the artifact this product is built around.
 *
 * One block per habit, weeks running left to right and weekdays top to bottom,
 * so a gap in a row is a week that went wrong and a gap in a column is a day of
 * the week that never works. That second reading is the one a list of streaks
 * cannot give you, and it is the reason this screen exists.
 *
 * GET /api/grid packs a day into a single character, so a year of one habit is
 * a 364-character string. Nothing here recomputes a score: the cells arrive
 * decided, and the counts under each name are tallies of them, never a rate.
 * Consistency is a real calculation with real rules — skipped days leave the
 * denominator, paused days never enter it — and it belongs to /review.
 */
import { Fragment, useMemo, type CSSProperties, type MouseEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { Choice } from "../components/Choice";
import { ErrorBox } from "../components/ErrorBox";
import { Skeleton } from "../components/Skeleton";
import { CELL, tally, VERDICT_LABEL } from "../features/habits/verdict";
import { useGrid } from "../features/overview/queries";
import {
  addDays,
  formatDateLong,
  formatDateShort,
  formatMonthShort,
  formatWeekday,
} from "../lib/dates";
import type { GridHabit, GridPayload, IsoDate, Verdict } from "../types";

const RANGES = [
  { weeks: 4, label: "4w", title: "Last 4 weeks" },
  { weeks: 12, label: "12w", title: "Last 12 weeks" },
  { weeks: 26, label: "26w", title: "Last 26 weeks" },
  { weeks: 52, label: "1y", title: "Last year" },
];

const DEFAULT_WEEKS = 12;
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Seven looks for nine verdicts, and both collapses are deliberate.
 *
 * Paused and unscheduled draw the same, because the grid asks whether the day
 * was kept and both answer "nothing was asked of you" — the difference is still
 * in the cell's tooltip, where a reader who cares can find it. Inactive and
 * future get no mark at all: there is nothing to say about a day a habit did
 * not exist for, or has not reached yet.
 *
 * Fill and shape carry the state, never hue — a habit's colour identifies the
 * habit. Missed is the one warm mark and it is an outline, not a block of red.
 */
function paint(verdict: Verdict, tint: string): CSSProperties {
  switch (verdict) {
    case "done":
      return { background: tint };
    case "bonus":
      return { background: `color-mix(in srgb, ${tint} 40%, transparent)` };
    case "skipped":
      return { background: "var(--c-line)" };
    case "missed":
      return {
        background: `color-mix(in srgb, var(--c-warn) 14%, transparent)`,
        boxShadow: "inset 0 0 0 1.5px var(--c-warn)",
      };
    case "unlogged":
      return { boxShadow: "inset 0 0 0 1.5px var(--c-line-strong)" };
    case "paused":
    case "unscheduled":
      return { background: "var(--c-surface)" };
    default:
      return {};
  }
}

/** The dash on a skipped cell, drawn rather than iconed so it survives a 10px cell. */
const SkipMark = () => (
  <span aria-hidden="true" className="bg-muted block h-[1.5px] w-1/2 rounded-full" />
);

// --- the legend ------------------------------------------------------------

const LEGEND: { verdict: Verdict; label: string }[] = [
  { verdict: "done", label: "Done" },
  { verdict: "bonus", label: "Extra" },
  { verdict: "skipped", label: "Skipped" },
  { verdict: "missed", label: "Missed" },
  { verdict: "unlogged", label: "Not logged" },
  { verdict: "unscheduled", label: "Nothing asked" },
];

/** Only the marks actually on screen. A legend for states nobody has is noise. */
function Legend({ habits }: { habits: GridHabit[] }) {
  const present = useMemo(() => {
    const seen = new Set<Verdict>();
    for (const habit of habits) {
      for (const char of habit.cells) {
        const verdict = CELL[char];
        if (verdict) seen.add(verdict);
      }
    }
    if (seen.has("paused")) seen.add("unscheduled");
    return seen;
  }, [habits]);

  const shown = LEGEND.filter((item) => present.has(item.verdict));
  if (shown.length === 0) return null;

  return (
    <ul className="text-micro text-muted flex flex-wrap items-center gap-x-4 gap-y-2">
      {shown.map((item) => (
        <li key={item.verdict} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="grid h-4 w-4 shrink-0 place-items-center rounded-[3px]"
            // chart-1 stands in for "a habit's colour"; the shape is the part
            // the legend is actually teaching.
            style={paint(item.verdict, "var(--c-chart-1)")}
          >
            {item.verdict === "skipped" && <SkipMark />}
          </span>
          {item.label}
        </li>
      ))}
    </ul>
  );
}

// --- one habit -------------------------------------------------------------

/**
 * What the row amounts to, in counts. Bonus days are counted as done because
 * they were done — the day simply was not asked for, which the grid already
 * shows by drawing them lighter.
 */
function summaryLine(habit: GridHabit, today: IsoDate): string {
  const counts = tally(habit.cells);
  const parts: string[] = [];

  if (habit.weeks) {
    /*
     * A week that has not been fully lived is provisional: it can be satisfied,
     * but it can never fail. The payload reports met=false for the week that
     * started this morning exactly as it does for one that genuinely fell
     * short, so counting every week would report today's week as a miss before
     * it has happened — and quietly deflate the ratio every Monday.
     */
    const decided = habit.weeks.filter(
      (week) => week.target !== null && (week.met || addDays(week.start, 6) < today),
    );
    if (decided.length > 0) {
      const met = decided.filter((week) => week.met).length;
      parts.push(`${met} of ${decided.length} week${decided.length === 1 ? "" : "s"} met`);
    }
  }

  parts.push(`${(counts.done ?? 0) + (counts.bonus ?? 0)} done`);
  if (counts.missed) parts.push(`${counts.missed} missed`);
  if (counts.unlogged) parts.push(`${counts.unlogged} not logged`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);

  return parts.join(" · ");
}

function HabitBlock({
  habit,
  payload,
  onPick,
}: {
  habit: GridHabit;
  payload: GridPayload;
  onPick: (date: IsoDate) => void;
}) {
  const { start, weeks, today } = payload;
  const tint = `var(--c-${habit.color_token})`;
  const mondays = useMemo(
    () => Array.from({ length: weeks }, (_, index) => addDays(start, index * 7)),
    [start, weeks],
  );

  // Labelled only where the month turns over, and never on the first column,
  // where a label would collide with the turn a week or two later.
  const months = useMemo(
    () =>
      mondays.map((monday, index) => {
        const previous = mondays[index - 1];
        const month = formatMonthShort(monday);
        return previous && formatMonthShort(previous) !== month ? month : null;
      }),
    [mondays],
  );

  // One listener on the grid rather than a link in all 364 cells: a cell is a
  // 14px square, so it is a pointer shortcut to the day, not a control. The
  // keyboard route to any day is the Day screen, which owns editing anyway.
  const pick = (event: MouseEvent<HTMLDivElement>) => {
    const date = (event.target as HTMLElement).closest<HTMLElement>("[data-date]")?.dataset.date;
    if (date) onPick(date);
  };

  return (
    // min-w-0 is what makes the scroller below actually scroll. This section is
    // a grid item, and a grid item's default min-width:auto refuses to shrink
    // below its content's min-content width — 706px for a year of columns — so
    // the whole page took that width and scrolled sideways instead, stranding
    // the nav and the heading in the left 360px. 26w and 52w both did it.
    <section className="min-w-0">
      {/* Outside the scroller, so the name it belongs to cannot slide away from
          the row when a year of columns has to scroll on a phone. */}
      <header className="pb-2">
        <h2 className="text-row flex items-center gap-2 font-medium">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            // A retired habit is still itself, just no longer asked for — the
            // colour hollows out, as a paused one does on /habits.
            style={{ background: tint, opacity: habit.archived_on ? 0.35 : 1 }}
          />
          <span className={habit.archived_on ? "text-muted" : undefined}>{habit.name}</span>
          {/* Said here rather than left to the row simply stopping: a row that
              ends with no explanation reads as a habit that was dropped. */}
          {habit.archived_on && (
            <span className="border-line text-micro text-muted shrink-0 rounded border px-1.5 py-0.5 font-normal">
              Archived {formatDateShort(habit.archived_on)}
            </span>
          )}
        </h2>
        <p className="text-meta text-muted tabular">{summaryLine(habit, today)}</p>
      </header>

      {/* Columns shrink to fit the screen and stop at 10px; past that this
          block scrolls on its own rather than squeezing a year into a phone. */}
      <div className="overflow-x-auto pb-1">
        <div
          /*
           * The grid is a picture. A screen reader should not be walked through
           * 364 cells of it — the line above is its text alternative, and every
           * day in it is reachable, readable and editable on the Day screen.
           */
          aria-hidden="true"
          onClick={pick}
          className="grid w-full min-w-min gap-[3px]"
          style={{ gridTemplateColumns: `auto repeat(${weeks}, minmax(10px, 28px))` }}
        >
          <span />
          {mondays.map((monday, index) => (
            <span key={monday} className="text-micro text-muted relative h-4">
              {months[index] && (
                <span className="absolute bottom-0 left-0 whitespace-nowrap">{months[index]}</span>
              )}
            </span>
          ))}

          {WEEKDAYS.map((row) => (
            <Fragment key={row}>
              <span className="text-micro text-muted self-center pr-1.5 leading-none">
                {formatWeekday(addDays(start, row))}
              </span>
              {mondays.map((_monday, index) => {
                const offset = index * 7 + row;
                const date = addDays(start, offset);
                const char = habit.cells[offset];
                const verdict = (char ? CELL[char] : null) ?? "inactive";

                return (
                  <span
                    key={date}
                    data-date={date}
                    title={`${formatDateLong(date)} — ${VERDICT_LABEL[verdict]}`}
                    className="grid aspect-square cursor-pointer place-items-center rounded-[3px]"
                    style={{
                      ...paint(verdict, tint),
                      ...(date === today
                        ? { outline: "1px solid var(--c-line-strong)", outlineOffset: "1px" }
                        : null),
                    }}
                  >
                    {verdict === "skipped" && <SkipMark />}
                  </span>
                );
              })}
            </Fragment>
          ))}

          {/* A weekly habit's week is not told by its cells — three days out of
            seven can be a perfect week or a failed one. The bar says which. */}
          {habit.weeks && (
            <>
              <span />
              {habit.weeks.map((week) => (
                <span
                  key={week.start}
                  className="mt-1 block h-[3px] self-center rounded-full"
                  style={{ background: week.target ? "var(--c-line)" : "transparent" }}
                >
                  {week.target !== null && (
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${Math.min(1, week.done / week.target) * 100}%`,
                        background: week.met
                          ? tint
                          : `color-mix(in srgb, ${tint} 45%, transparent)`,
                      }}
                    />
                  )}
                </span>
              ))}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// --- the screen ------------------------------------------------------------

const GridSkeleton = () => (
  <div className="grid gap-8 pt-2">
    {[0, 1, 2].map((block) => (
      <div key={block} className="grid gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-36" />
      </div>
    ))}
  </div>
);

export default function Grid() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  // The range lives in the URL so a reload, a back button and a shared link all
  // land on the same picture.
  const requested = Number(params.get("weeks"));
  const weeks = RANGES.some((range) => range.weeks === requested) ? requested : DEFAULT_WEEKS;

  const query = useGrid(weeks);
  const data = query.data;

  return (
    <div className="mx-auto w-full max-w-[68rem] px-4 pb-20 sm:px-6 lg:px-8">
      <header className="pt-5 pb-7 sm:pt-8">
        <h1 className="font-serif text-date tracking-[-0.015em]">Consistency</h1>
        <p className="text-meta text-muted tabular mt-1 min-h-[1.125rem]">
          {data ? `${formatDateShort(data.start)} – ${formatDateShort(data.end)}` : ""}
        </p>

        <div role="group" aria-label="Range" className="mt-4 grid max-w-xs grid-cols-4 gap-1.5">
          {RANGES.map((range) => (
            <Choice
              key={range.weeks}
              type="radio"
              name="range"
              checked={range.weeks === weeks}
              onChange={() => setParams({ weeks: String(range.weeks) }, { replace: true })}
              label={range.title}
            >
              {range.label}
            </Choice>
          ))}
        </div>
      </header>

      {query.isError && !data ? (
        <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
      ) : !data ? (
        <GridSkeleton />
      ) : data.habits.length === 0 ? (
        <section>
          <p className="text-row">Nothing to show yet.</p>
          <p className="text-muted mt-1 max-w-sm">
            The grid fills in as you log days. Add a habit on the day screen and come back in a
            week.
          </p>
        </section>
      ) : (
        <div
          className={`transition-opacity ${query.isPlaceholderData ? "opacity-50" : "opacity-100"}`}
        >
          <div className="grid gap-9">
            {data.habits.map((habit) => (
              <HabitBlock
                key={habit.id}
                habit={habit}
                payload={data}
                onPick={(date) => navigate(`/day/${date}`)}
              />
            ))}
          </div>

          <div className="border-line mt-9 border-t pt-5">
            <Legend habits={data.habits} />
            <p className="text-micro text-muted mt-3">Tap any square to open that day.</p>
          </div>
        </div>
      )}
    </div>
  );
}
