/**
 * The sheet — seven weekday channels of pre-ruled chart paper, weeks running
 * left to right, with the record inked on top.
 *
 * This is the artifact the product is built around, and it is drawn in ONE
 * place: /grid stacks one per habit, /habits/:id gives a single habit the whole
 * width. They used to be two copies of the same grid and had already drifted
 * apart once.
 *
 * Weekdays run DOWN and weeks run ACROSS, which is not a layout preference. A
 * gap in a row is a week that went wrong; a gap in a column is a day of the
 * week that never works. That second reading is the one a list of streaks
 * cannot give you and it is the reason the screen exists — so the channels stay
 * seven, whatever else changes.
 *
 * Three layers, and the order matters:
 *
 *   PAPER    (z0) the ruling. One rule per channel per RUN of like days, so a
 *                 pause is one pecked rule and not nine pecked cells.
 *   INK      (z2) paint() — four marks over nine verdicts. See verdict.ts.
 *   OVERLAY  (z4) the pen at today, schedule cuts, the archive end-cap.
 *
 * It does NOT own a scroller, and does not choose its own cell size. One
 * scroller wraps every block on the grid — seven independent ones meant seven
 * rows parked on seven different weeks, so a column no longer meant a date —
 * and both halves of that live in sheet-view.ts.
 *
 * The whole drawing is aria-hidden. That boundary is the most dangerous line on
 * the screen: its text alternative is the summary line the CALLER renders
 * beside it, and nothing would fail if this were raised to cover that — the
 * screen would simply stop existing for a screen reader, and look perfect.
 */
import { Fragment } from "react";

import {
  addDays,
  daysBetween,
  formatDateLong,
  formatMonthShort,
  formatWeekday,
} from "../../lib/dates";
import type { IsoDate, Verdict } from "../../types";
import { SkipMark } from "./marks";
import { CELL, paint, paperOf, VERDICT_LABEL, type Paper } from "./verdict";

/** The weekday axis. One letter, because 26 weeks on a phone leaves 18px. */
const AXIS = 18;
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/** A schedule version drawn as a cut through the record. */
export type Cut = { date: IsoDate; label: string | null };

export type SheetProps = {
  /** `weeks * 7` characters from `start`, Monday first. See GridPayload. */
  cells: string;
  /** The Monday `cells[0]` falls on. */
  start: IsoDate;
  weeks: number;
  /** The server's today, in APP_TIMEZONE. Never the browser's. */
  today: IsoDate;
  tint: string;
  cell: number;
  gap: number;
  /** Schedule versions, oldest first. Labels are dropped where two cuts collide. */
  cuts?: Cut[];
  /** Where the record stops. Drawn as an ink end-cap. */
  archivedOn?: IsoDate | null;
  /** Per-week counts of days written on, and how far back the pages reach. */
  annotations?: { perWeek: Map<number, number>; from: number; complete: boolean } | null;
};

/** Which week column a date falls in, or null if it is off this sheet. */
function weekOf(date: IsoDate, start: IsoDate, weeks: number): number | null {
  const offset = daysBetween(start, date);
  if (offset < 0) return null;
  const week = Math.floor(offset / 7);
  return week < weeks ? week : null;
}

const PAPER_CLASS: Record<Exclude<Paper, "none">, string> = {
  on: "bg-tray",
  peck: "peck-paper",
  // Ahead of the pen: blank paper, and the only place opacity carries meaning.
  dim: "bg-tray opacity-40",
};

export function Sheet({
  cells,
  start,
  weeks,
  today,
  tint,
  cell,
  gap,
  cuts = [],
  archivedOn = null,
  annotations = null,
}: SheetProps) {
  const colX = (week: number) => AXIS + gap + week * (cell + gap);
  const half = gap / 2;
  const laneHeight = 7 * (cell + gap);
  const width = AXIS + gap + weeks * (cell + gap);

  const penWeek = weekOf(today, start, weeks);
  const penX = penWeek === null ? null : colX(penWeek) + cell / 2;

  /*
   * One rule per RUN of like days, not one per cell.
   *
   * A 46-week sheet is 322 cells; grouping turns that into a handful of rules
   * per channel, and it is also the only way a pecked pause reads as one
   * continuous mark rather than nine separate dashes that happen to line up.
   */
  const paper: { key: string; top: number; left: number; width: number; kind: Paper }[] = [];
  for (const row of WEEKDAYS) {
    const top = row * (cell + gap) + cell + Math.floor(gap / 2);
    let runStart: number | null = null;
    let runKind: Paper = "none";

    const flush = (endWeek: number) => {
      if (runStart === null || runKind === "none") return;
      const left = colX(runStart) - half;
      paper.push({
        key: `${row}-${runStart}`,
        top,
        left,
        width: colX(endWeek) + cell + half - left,
        kind: runKind,
      });
    };

    for (let week = 0; week < weeks; week++) {
      const kind = paperOf(CELL[cells[week * 7 + row] ?? ""] ?? "inactive");
      if (kind !== runKind) {
        flush(week - 1);
        runStart = week;
        runKind = kind;
      }
    }
    flush(weeks - 1);
  }

  const mondays = Array.from({ length: weeks }, (_unused, week) => addDays(start, week * 7));

  return (
    /*
     * aria-hidden STARTS HERE and must never be raised to cover the summary
     * line the caller renders above this. A cell is an 11px square: it is a
     * pointer shortcut to the day, not a control, and the addressable route to
     * any day is the Day screen, which owns editing anyway. Nothing inside is
     * focusable, which is what keeps the two facts consistent.
     */
    <div aria-hidden="true" style={{ width, paddingTop: 36 }} className="relative select-none">
      {/* Registration marks — the corners of a printed sheet. */}
      <span className="border-tray absolute top-0 left-0 h-2 w-2 border-t border-l" />
      <span className="border-tray absolute top-0 right-0 h-2 w-2 border-t border-r" />
      <span className="border-tray absolute bottom-0 left-0 h-2 w-2 border-b border-l" />
      <span className="border-tray absolute right-0 bottom-0 h-2 w-2 border-r border-b" />

      {/* The scale: month names where the month turns, and nowhere else. Never
          on the first column, where a label would collide with the turn a week
          or two later. */}
      <div className="absolute top-[22px] right-0 left-0" style={{ marginLeft: AXIS }}>
        {mondays.map((monday, week) => {
          const previous = mondays[week - 1];
          if (!previous || formatMonthShort(previous) === formatMonthShort(monday)) return null;
          return (
            <span
              key={monday}
              className="label-tick text-muted absolute whitespace-nowrap"
              style={{ left: colX(week) + 3 - AXIS }}
            >
              {formatMonthShort(monday)}
            </span>
          );
        })}
      </div>

      <div className="relative" style={{ height: laneHeight }}>
        {/* --- PAPER -------------------------------------------------- */}
        <div className="absolute inset-0 z-0">
          {/* Week boundaries and month majors, crossing the ruling. Printed
              furniture, so they take the paper's own inks. */}
          {mondays.map((monday, week) => {
            const previous = mondays[week - 1];
            const turn = previous && formatMonthShort(previous) !== formatMonthShort(monday);
            return (
              <span
                key={monday}
                className={`absolute bottom-0 w-px ${turn ? "bg-tray" : "bg-grid"}`}
                style={{ left: colX(week) - half, top: turn ? -8 : 0 }}
              />
            );
          })}
          {paper.map((run) => (
            <span
              key={run.key}
              className={`absolute h-px ${PAPER_CLASS[run.kind as Exclude<Paper, "none">]}`}
              style={{ top: run.top, left: run.left, width: run.width }}
            />
          ))}
        </div>

        {/* --- OVERLAY ------------------------------------------------ */}
        <div className="pointer-events-none absolute inset-0 z-[4]">
          {penX !== null && (
            <>
              {/* The pen. One ink vertical through all seven channels — the
                  single most identifying mark on the screen, and the reason the
                  ruling can run on past it at 40% as blank paper. */}
              <span className="bg-ink absolute w-px" style={{ left: penX, top: -8, bottom: -4 }} />
              <span
                className="absolute h-0 w-0"
                style={{
                  left: penX - 4,
                  top: -34,
                  borderLeft: "4px solid transparent",
                  borderRight: "4px solid transparent",
                  borderBottom: "7px solid var(--c-ink)",
                }}
              />
            </>
          )}

          {cuts.map((cut) => {
            const week = weekOf(cut.date, start, weeks);
            if (week === null) return null;
            return (
              <Fragment key={cut.date}>
                <span
                  className="absolute top-[-4px] bottom-0 border-l border-dashed"
                  style={{ left: colX(week) - half, borderColor: "var(--c-ink)", opacity: 0.7 }}
                />
                {cut.label && (
                  <span
                    className="label-tick text-ink absolute whitespace-nowrap"
                    style={{ left: colX(week) - half + 4, top: -34 }}
                  >
                    {cut.label}
                  </span>
                )}
              </Fragment>
            );
          })}

          {/* Where the record stops. A row that ends with nothing to explain it
              reads as a habit that was dropped. */}
          {archivedOn &&
            (() => {
              const week = weekOf(archivedOn, start, weeks);
              return week === null ? null : (
                <span
                  className="bg-ink absolute top-[-4px] bottom-0 w-px"
                  style={{ left: colX(week) + cell + half }}
                />
              );
            })()}
        </div>

        {/* --- INK ---------------------------------------------------- */}
        <div
          className="relative z-[2] grid"
          style={{
            gridTemplateColumns: `${AXIS}px repeat(${weeks}, ${cell}px)`,
            gap: `${gap}px`,
          }}
        >
          {WEEKDAYS.map((row) => (
            <Fragment key={row}>
              <span
                // Sticky, so the one label saying which channel this is cannot
                // be the first thing to scroll off.
                className="label-tick text-muted bg-canvas sticky left-0 z-[1] flex items-center justify-end pr-1"
              >
                {formatWeekday(addDays(start, row)).charAt(0)}
              </span>
              {mondays.map((_monday, week) => {
                const offset = week * 7 + row;
                const date = addDays(start, offset);
                const verdict: Verdict = CELL[cells[offset] ?? ""] ?? "inactive";
                return (
                  <span
                    key={date}
                    data-date={date}
                    title={`${formatDateLong(date)} — ${VERDICT_LABEL[verdict]}`}
                    className="grid cursor-pointer place-items-center"
                    style={{ height: cell, ...paint(verdict, tint) }}
                  >
                    {verdict === "skipped" && <SkipMark />}
                  </span>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>

      {/*
       * The annotation rule: one tick per week that was written on, taller
       * where more days in it were.
       *
       * Per WEEK because the sheet's horizontal resolution is a week — all
       * seven days share one column. It lives below the channels rather than
       * inside a cell on purpose: an 11px cell already carries five
       * distinctions, and a sixth mark for "this day was written on" would cost
       * the greyscale reading the whole vocabulary is verified for.
       *
       * It is drawn only across the pages that have LOADED, and says so: the
       * rule stops at an open bracket where older notes have not been asked for
       * yet. A rule running the whole width would be claiming to have read a
       * record it has not.
       */}
      {annotations && (
        <div className="relative mt-1.5" style={{ height: 13 }}>
          <span
            className="bg-grid absolute h-px"
            style={{ top: 6, left: colX(annotations.from) - half, right: 0 }}
          />
          {!annotations.complete && (
            <span
              className="border-tray absolute h-2 w-1.5 border-y border-l"
              style={{ top: 2, left: Math.max(0, colX(annotations.from) - half - 7) }}
            />
          )}
          {[...annotations.perWeek].map(([week, count]) => {
            const height = count >= 3 ? 11 : count === 2 ? 8 : 5;
            return (
              <span
                key={week}
                className="bg-baseline absolute w-0.5"
                style={{ left: colX(week) + cell / 2 - 1, top: 11 - height, height }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
