/**
 * Pattern — the consistency sheet, and the artifact this product is built
 * around.
 *
 * One sheet of pre-ruled chart paper per habit, weeks running left to right and
 * weekdays top to bottom, so a gap in a row is a week that went wrong and a gap
 * in a column is a day of the week that never works. That second reading is the
 * one a list of streaks cannot give you, and it is the reason this screen
 * exists.
 *
 * GET /api/grid packs a day into a single character, so a year of one habit is
 * a 364-character string. Nothing here recomputes a score: the cells arrive
 * decided, and the counts beside each name are tallies of them, never a rate.
 * Consistency is a real calculation with real rules — skipped days leave the
 * denominator, paused days never enter it — and it belongs to /review. That is
 * also why this screen is headed "Pattern": naming it Consistency put a second
 * name on a number that is computed one tab over, under different rules.
 *
 * ONE scroller for every block, not one each. Seven independent scrollers meant
 * seven rows that could be parked on seven different weeks, so a column no
 * longer meant a date and the vertical reading above was quietly wrong.
 */
import type { MouseEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { Choice } from "../components/Choice";
import { ErrorBox } from "../components/ErrorBox";
import { Chevron } from "../components/icons";
import { Skeleton } from "../components/Skeleton";
import { Legend } from "../features/habits/Legend";
import { Sheet } from "../features/habits/Sheet";
import { useParkedScroller } from "../features/habits/sheet-view";
import { tally } from "../features/habits/verdict";
import { useGrid } from "../features/overview/queries";
import { formatDateShort } from "../lib/dates";
import type { GridHabit, GridPayload } from "../types";

/**
 * Each range draws at its own cell size, and the sizes are not a taste: 26
 * weeks at 11px is the last width at which both the weekday axis and the dotted
 * "not logged" ring still resolve, and 26 columns of it is exactly the 358px a
 * 390px phone has.
 *
 * `wide` is the year, and it is a desktop range. A year of columns on a phone
 * puts the cell at 6px, where the axis becomes an overlapping smear and the
 * dotted ring degrades into texture — the reading the sheet exists for stops
 * working before the layout does. Rather than ship a range that photographs
 * well and says nothing, the chip is hidden below `md`, where the cell gets
 * 11px and both readings survive.
 *
 * The year used to run at cell 12 / gap 1, and the gap is why it moved to
 * 11 / 2: the channel ruling lives IN the gap, and at 1px there is nowhere to
 * put it. Without the ruling the year would be the one range with no carrier
 * for alive, paused or inactive — a second vocabulary on the same screen. The
 * sheet is 4px wider than it was.
 */
const RANGES = [
  { weeks: 4, label: "4w", title: "Last 4 weeks", cell: 26, gap: 3, wide: false },
  { weeks: 12, label: "12w", title: "Last 12 weeks", cell: 17, gap: 2, wide: false },
  { weeks: 26, label: "26w", title: "Last 26 weeks", cell: 11, gap: 2, wide: false },
  { weeks: 52, label: "1y", title: "Last year", cell: 11, gap: 2, wide: true },
];

const DEFAULT_WEEKS = 12;

/** Said in one place, because it is shown from two, at different widths. */
const NO_HISTORY = "Longer ranges need more history.";

// --- one habit -------------------------------------------------------------

/**
 * What the row amounts to, in counts. Bonus days are counted as done because
 * they were done — the day simply was not asked for, which the sheet already
 * shows by drawing them lighter.
 *
 * This line is the sheet's TEXT ALTERNATIVE. The drawing below it is
 * aria-hidden, so if this stops naming every state present, the screen stops
 * existing for a screen reader and still looks perfect.
 */
function summaryLine(habit: GridHabit): string {
  const counts = tally(habit.cells);
  const parts: string[] = [];
  const done = (counts.done ?? 0) + (counts.bonus ?? 0);
  parts.push(`${done} done`);
  if (counts.missed) parts.push(`${counts.missed} missed`);
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  if (counts.unlogged) parts.push(`${counts.unlogged} not logged`);
  if (counts.paused) {
    parts.push(`${counts.paused} ${counts.paused === 1 ? "day" : "days"} paused`);
  }
  return parts.join(" · ");
}

function HabitBlock({
  habit,
  payload,
  range,
}: {
  habit: GridHabit;
  payload: GridPayload;
  range: (typeof RANGES)[number];
}) {
  const tint = `var(--c-${habit.color_token})`;

  return (
    <section className="pt-9 first:pt-0 lg:grid lg:grid-cols-[15rem_max-content] lg:items-start lg:gap-x-11 lg:pt-10">
      {/*
       * OUTSIDE the aria-hidden sheet below, and stuck to the left edge so a
       * year of columns cannot slide the name away from the row it names.
       *
       * On a wide screen it moves BESIDE the sheet instead of above it, which
       * is what makes every sheet start at the same x — and therefore what
       * makes the pen at today run unbroken down the whole page.
       */}
      <header className="bg-canvas sticky left-0 z-[2] w-fit max-w-full pr-3 pb-2 lg:static lg:pt-8">
        <h2 className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="h-5 w-[3px] shrink-0"
            // A retired habit is still itself, just no longer asked for — the
            // pen bar hollows out, as a paused habit's dot does on /habits.
            style={{ background: tint, opacity: habit.archived_on ? 0.35 : 1 }}
          />
          {/* Where you notice a habit has gone strange is here, so this is
              where the way into its whole history belongs. */}
          <Link
            to={`/habits/${habit.id}`}
            className={`hover:text-ink font-serif text-name inline-flex min-h-9 items-center gap-1 ${
              habit.archived_on ? "text-muted" : ""
            }`}
          >
            {habit.name}
            <Chevron className="text-muted" />
          </Link>
        </h2>
        {/* Said here rather than left to the row simply stopping: a row that
            ends with no explanation reads as a habit that was dropped. */}
        {habit.archived_on && (
          <p className="label text-muted mt-1.5">Archived {formatDateShort(habit.archived_on)}</p>
        )}
        <p className="label text-muted mt-2 max-w-[15rem] leading-[1.5]">{summaryLine(habit)}</p>
      </header>

      <Sheet
        cells={habit.cells}
        start={payload.start}
        weeks={payload.weeks}
        today={payload.today}
        tint={tint}
        cell={range.cell}
        gap={range.gap}
        archivedOn={habit.archived_on}
      />

      {/* A weekly habit's week is not told by its cells — three days out of
          seven can be a perfect week or a failed one. The bar says which, and
          it sits on its own rule below the seven channels rather than floating. */}
      {habit.weeks && (
        <div
          aria-hidden="true"
          className="lg:col-start-2"
          style={{
            display: "grid",
            gridTemplateColumns: `18px repeat(${payload.weeks}, ${range.cell}px)`,
            gap: `${range.gap}px`,
            width: "max-content",
          }}
        >
          <span />
          {habit.weeks.map((week) => (
            <span
              key={week.start}
              className="mt-1.5 block h-[3px] self-center"
              style={{ background: week.target ? "var(--c-tray)" : "transparent" }}
            >
              {week.target !== null && (
                <span
                  className="block h-full"
                  style={{
                    width: `${Math.min(1, week.done / week.target) * 100}%`,
                    background: week.met ? tint : `color-mix(in srgb, ${tint} 45%, transparent)`,
                  }}
                />
              )}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

// --- the screen ------------------------------------------------------------

/**
 * Leading weeks in which no habit existed at all.
 *
 * It speaks only about ranges LONGER than the one on screen, and that is all it
 * can honestly speak about: if 26 weeks already opens on dead columns, a year
 * shows the same record with more emptiness in front of it, so that chip is
 * offered dimmed rather than promising a picture that does not exist. From a
 * range with no dead columns nothing follows, and nothing is concluded.
 */
function deadLeadingWeeks(habits: GridHabit[], weeks: number): number {
  let dead = 0;
  for (let week = 0; week < weeks; week++) {
    const base = week * 7;
    const alive = habits.some((habit) => {
      for (let day = 0; day < 7; day++) if (habit.cells[base + day] !== "-") return true;
      return false;
    });
    if (alive) break;
    dead++;
  }
  return dead;
}

const GridSkeleton = () => (
  <div className="grid gap-9 pt-2">
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
  const known = RANGES.find((item) => item.weeks === requested);
  const range = known ?? RANGES.find((item) => item.weeks === DEFAULT_WEEKS)!;
  const weeks = range.weeks;

  const query = useGrid(weeks);
  const data = query.data;

  // One scroller for the whole page, keyed on the payload's own start and weeks
  // rather than on the requested range — so while keepPreviousData holds the
  // old sheet on screen this cannot fire against cells that are about to change.
  const scroller = useParkedScroller([data?.start, data?.weeks, range.cell]);

  // One listener for the whole sheet rather than a link in every cell: a cell
  // is an 11px square, so it is a pointer shortcut to the day, not a control.
  // The keyboard route to any day is the Day screen, which owns editing anyway.
  const pick = (event: MouseEvent<HTMLDivElement>) => {
    const date = (event.target as HTMLElement).closest<HTMLElement>("[data-date]")?.dataset.date;
    if (date) navigate(`/day/${date}`);
  };

  const dead = data ? deadLeadingWeeks(data.habits, data.weeks) : 0;
  // Split by whether the dimmed chip is one this width shows at all.
  const shortDisabled = dead > 0 && RANGES.some((item) => !item.wide && item.weeks > weeks);
  const wideDisabled = dead > 0 && RANGES.some((item) => item.wide && item.weeks > weeks);

  return (
    <div className="mx-auto w-full max-w-[84rem] px-4 pb-24 sm:px-6 lg:px-8">
      <header className="pt-6 pb-8 sm:pt-10">
        <p className="label text-muted">Sheet · {range.title.replace("Last ", "")}</p>
        <h1 className="font-serif text-title mt-2 tracking-[-0.015em]">Pattern</h1>
        <p className="font-mono text-meta text-muted mt-2 min-h-[1.125rem]">
          {data ? `${formatDateShort(data.start)} – ${formatDateShort(data.end)}` : ""}
        </p>

        <div role="group" aria-label="Range" className="mt-5 flex max-w-xs">
          {RANGES.map((item) => {
            // Longer than anything on record: see deadLeadingWeeks.
            const empty = dead > 0 && item.weeks > weeks;
            return (
              <Choice
                key={item.weeks}
                type="radio"
                name="range"
                checked={item.weeks === weeks}
                disabled={empty}
                onChange={() => setParams({ weeks: String(item.weeks) }, { replace: true })}
                // A dimmed control that will not say why is a control that
                // looks broken. The reason rides on the label, so it reaches a
                // screen reader as well as the note below reaches everyone else.
                label={empty ? `${item.title} — no record goes back that far` : item.title}
                /*
                 * A year needs 52 columns, which is a desktop picture, so it is
                 * offered on one — except when it is the range being shown,
                 * which a link from a desktop can make true on a phone. A hidden
                 * chip that is also the selected one leaves every chip looking
                 * unselected.
                 */
                className={item.wide && item.weeks !== weeks ? "hidden md:flex" : ""}
              >
                {item.label}
              </Choice>
            );
          })}
        </div>

        {/*
         * At most one line, and each one is tied to a control the reader can
         * actually see.
         *
         * The year chip is hidden below `md`, so a phone showing "longer ranges
         * need more history" would be explaining a dimmed control that is not on
         * the screen — which is how a note meant to remove confusion adds some.
         */}
        {shortDisabled ? (
          <p className="label text-muted mt-3">{NO_HISTORY}</p>
        ) : wideDisabled ? (
          <p className="label text-muted mt-3 hidden md:block">{NO_HISTORY}</p>
        ) : (
          <p className="label text-muted mt-3 md:hidden">
            A full year fits on a wider screen; the squares would be too small to read here.
          </p>
        )}
      </header>

      {query.isError && !data ? (
        <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
      ) : !data ? (
        <GridSkeleton />
      ) : data.habits.length === 0 ? (
        <section>
          <p className="font-serif text-name">Nothing to show yet.</p>
          <p className="text-muted mt-2 max-w-sm">
            The sheet fills in as you log days. Add a habit on the day screen and come back in a
            week.
          </p>
        </section>
      ) : (
        <div
          className={`transition-opacity ${query.isPlaceholderData ? "opacity-50" : "opacity-100"}`}
        >
          {/* Before the sheet, not after it. It used to sit under a page of
              squares, where it was found — if at all — long after it was
              needed. */}
          <div className="border-baseline mb-7 border-b pb-5">
            <Legend cells={data.habits.map((habit) => habit.cells).join("")} />
          </div>

          {/* One scroller, one set of columns. Every block below is parked on
              the same week as every other, which is what makes a column mean a
              date — and what lets the pen at today line up down the page. */}
          <div ref={scroller} onClick={pick} className="overflow-x-auto pb-1">
            <div className="w-max min-w-full">
              {data.habits.map((habit) => (
                <HabitBlock key={habit.id} habit={habit} payload={data} range={range} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
