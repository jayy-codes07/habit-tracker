/**
 * The Day screen — and, with the date set to today, the whole of "Today".
 *
 * There is no separate Today screen on purpose. Logging this morning and fixing
 * last Tuesday are the same job, so they are the same screen with a different
 * date, and GET /api/day/:date paints all of it in one request: habits with
 * their state and streaks, the tasks that were due, and the day's note.
 *
 * Day is the instrument's READOUT, not its chart paper. The payload carries no
 * per-habit history, so there is no honest trace to draw here and none is
 * invented. What it has instead is the concept at its most direct: every habit
 * is a CHANNEL, and the channel's own rule carries the day — solid for a rest
 * day, pecked while paused, broken where nothing was logged, dimmed for a day
 * that has not arrived — with the measurement set into a break in that rule
 * rather than captioned beneath it.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";

import { ErrorBox } from "../components/ErrorBox";
import { FIELD, ICON_BUTTON, PRIMARY } from "../components/form";
import { Check, Chevron, Ellipsis } from "../components/icons";
import { Skeleton } from "../components/Skeleton";
import { HabitSheet } from "../features/habits/HabitSheet";
import { NewHabitDialog } from "../features/habits/NewHabitDialog";
import { useSetLog } from "../features/habits/queries";
import {
  amountLine,
  isActionable,
  markOf,
  metaLine,
  stateLabel,
  summarise,
  type Mark as MarkKind,
} from "../features/habits/verdict";
import { useSaveJournal } from "../features/journal/queries";
import { useDay } from "../features/overview/queries";
import { useCreateTask, usePatchTask } from "../features/tasks/queries";
import {
  addDays,
  browserToday,
  daysBetween,
  formatDateLong,
  formatMonthLong,
  formatMonthShort,
  formatWeekday,
  isoWeekday,
  monthOf,
  relativeDay,
} from "../lib/dates";
import type { ColorToken, DayHabit, IsoDate, JournalEntry, Task } from "../types";

/** The channel rule sits here, and every mark is placed against it. */
const RULE_TOP = 48;

/**
 * The state of one habit on one day, as GEOMETRY against the channel's rule.
 *
 * On the rule is what was asked of you. Above it is more than was asked. Below
 * it is a day that failed. A habit's colour identifies the habit and never says
 * how the day went — missed is the only warm mark in the list, and it is a
 * hollow outline hanging under the line: a tracker that shouts at you is a
 * tracker you stop opening.
 *
 * `open` is two different days and they are drawn differently. A day that was
 * never logged BREAKS the rule — absence drawn as absence. Today, still open,
 * is a dashed target sitting on the rule: something to hit, not something
 * already lost.
 */
function Mark({
  mark,
  color,
  unlogged,
  rule = RULE_TOP,
}: {
  mark: MarkKind;
  color: ColorToken;
  unlogged: boolean;
  /** Where the channel's rule sits in the box. The key below draws the same
      marks against a shorter one, so there is one implementation of the
      geometry rather than a second, decorative copy of it. */
  rule?: number;
}) {
  const tint = `var(--c-${color})`;
  const box = "absolute left-4 h-3.5 w-3.5";

  switch (mark) {
    case "done":
      return (
        <span
          aria-hidden="true"
          className={`${box} motion-safe:animate-[seat_140ms_ease-out]`}
          style={{ top: rule - 13, background: tint }}
        />
      );
    case "extra":
      return (
        <span
          aria-hidden="true"
          className={`${box} motion-safe:animate-[seat_140ms_ease-out]`}
          style={{
            top: rule - 22,
            background: `color-mix(in srgb, ${tint} 45%, transparent)`,
          }}
        >
          {/* The stem is what keeps it attached to the measurement: a mark
              floating free of the rule would read as a different habit. */}
          <span className="bg-baseline absolute top-3.5 left-1/2 h-[9px] w-px" />
        </span>
      );
    case "skipped":
      return (
        <span
          aria-hidden="true"
          className="border-baseline absolute left-[19px] h-3 w-3 rotate-45 border-[1.5px]"
          style={{ top: rule - 6 }}
        />
      );
    case "missed":
      return (
        <span
          aria-hidden="true"
          className="border-warn absolute left-4 h-3.5 w-3.5 border-[1.5px]"
          style={{ top: rule + 1 }}
        />
      );
    default:
      return unlogged ? (
        // A gap in the rule, painted in the canvas over it.
        <span
          aria-hidden="true"
          className="bg-canvas absolute left-2.5 h-[3px] w-[30px]"
          style={{ top: rule - 1 }}
        />
      ) : (
        <span
          aria-hidden="true"
          className="border-faint absolute left-4 h-3.5 w-3.5 border border-dashed"
          style={{ top: rule - 13 }}
        />
      );
  }
}

/**
 * The key to the marks above — the same six drawn by the same function, at a
 * shorter rule.
 *
 * Folded shut, and that is the trade: every row already names its own state in
 * words beside it ("Done · 5 day streak"), so this answers the one question the
 * words do not — what the little square, diamond or gap in the line IS — without
 * putting two lines of legend between the day's count and the first habit to
 * tick. Pattern's key is a different drawing of a different vocabulary and is
 * its own component; a shared one would have to lie about one of them.
 */
const MARK_KEY: { mark: MarkKind; unlogged: boolean; label: string }[] = [
  { mark: "done", unlogged: false, label: "Done" },
  { mark: "extra", unlogged: false, label: "Extra, not scheduled" },
  { mark: "skipped", unlogged: false, label: "Skipped" },
  { mark: "missed", unlogged: false, label: "Missed" },
  { mark: "open", unlogged: true, label: "Not logged" },
  { mark: "open", unlogged: false, label: "Still to do" },
];

/** Rule at 26 of 44: enough room above for `extra` and below for `missed`. */
const KEY_RULE = 26;

function MarkKey() {
  return (
    <details className="group">
      <summary className="label text-muted hover:text-ink flex min-h-11 cursor-pointer list-none items-center gap-2">
        <Chevron className="transition-transform group-open:rotate-90" />
        What the marks mean
      </summary>
      <ul className="label text-muted flex flex-wrap items-center gap-x-6 pb-1">
        {MARK_KEY.map((item) => (
          <li key={item.label} className="flex items-center gap-1">
            <span aria-hidden="true" className="relative block h-11 w-14 shrink-0">
              <span className="bg-baseline absolute inset-x-0 h-px" style={{ top: KEY_RULE }} />
              {/* chart-1 stands in for "a habit's colour": the colour says which
                  habit, never how the day went. */}
              <Mark mark={item.mark} color="chart-1" unlogged={item.unlogged} rule={KEY_RULE} />
            </span>
            {item.label}
          </li>
        ))}
      </ul>
    </details>
  );
}

// --- habits ----------------------------------------------------------------

function HabitRow({
  habit,
  readOnly,
  failure,
  onToggle,
  onOpen,
}: {
  habit: DayHabit;
  readOnly: boolean;
  failure: string | null;
  onToggle: (habit: DayHabit) => void;
  onOpen: (habit: DayHabit) => void;
}) {
  const meta = metaLine(habit);
  /*
   * Reported beside the meta line, not instead of it. The meta line carries the
   * single most important fact about the day — a weekly habit's week still has
   * to be able to say where it stands — and the measurement is an additional
   * fact rather than a replacement for it. Null for every binary habit, and for
   * a day that was done without being measured.
   */
  const amount = amountLine(habit);
  const mark = markOf(habit);
  const tint = `var(--c-${habit.color_token})`;

  // The rule IS the habit's line, and its treatment is the day's nature.
  const rule = habit.paused ? "peck-rule" : readOnly ? "bg-baseline opacity-40" : "bg-baseline";

  return (
    <li>
      <div className="relative h-[4.5rem]">
        <span
          aria-hidden="true"
          className={`absolute inset-x-0 h-px ${rule}`}
          style={{ top: RULE_TOP }}
        />

        {/*
         * A weekly habit's week, drawn ON the rule: it thickens from the left
         * as the week fills. The words still say it in metaLine — this is the
         * glanceable copy, not a replacement.
         */}
        {habit.week?.target ? (
          <span
            aria-hidden="true"
            className="absolute left-0 h-[3px]"
            style={{
              top: RULE_TOP - 1,
              width: `${Math.min(1, habit.week.done / habit.week.target) * 100}%`,
              background: habit.week.met ? tint : `color-mix(in srgb, ${tint} 50%, transparent)`,
            }}
          />
        ) : null}

        <button
          type="button"
          aria-pressed={habit.status === "done"}
          disabled={readOnly}
          onClick={() => onToggle(habit)}
          className="absolute inset-y-0 right-10 left-0 text-left disabled:opacity-55"
        >
          <Mark mark={mark} color={habit.color_token} unlogged={habit.verdict === "unlogged"} />
          <span className="font-serif text-name absolute top-1.5 right-0 left-14 block truncate">
            {habit.name}
          </span>
          <span className="sr-only">, {stateLabel(habit)}</span>
          {/* The measurement, set into a break in the habit's own rule. */}
          {(meta || amount) && (
            <span
              className="label text-muted bg-canvas absolute right-0 -translate-y-1/2 pr-1 pl-2.5 whitespace-nowrap"
              style={{ top: RULE_TOP }}
            >
              {[amount, meta].filter(Boolean).join(" · ")}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => onOpen(habit)}
          aria-label={`More options for ${habit.name}`}
          className={`${ICON_BUTTON} absolute top-0.5 right-0`}
        >
          <Ellipsis />
        </button>
      </div>

      {habit.note && !failure && (
        <p className="text-muted -mt-2 pb-4 pl-14 font-serif">{habit.note}</p>
      )}

      {/* A failed tick has already rolled back. The explanation belongs on the
          row that failed, not in a corner of the screen. */}
      {failure && (
        <p role="alert" className="text-warn text-meta -mt-2 pb-4 pl-14">
          {failure}
        </p>
      )}
    </li>
  );
}

function Habits({
  habits,
  date,
  isToday,
  readOnly,
  onNewHabit,
}: {
  habits: DayHabit[];
  date: IsoDate;
  isToday: boolean;
  readOnly: boolean;
  onNewHabit: () => void;
}) {
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const setLog = useSetLog(date);

  const asked = habits.filter(isActionable);
  const resting = habits.filter((habit) => !isActionable(habit));
  const { done, left, total } = summarise(habits);

  const failedId = setLog.isError ? (setLog.variables?.habit.id ?? null) : null;
  const failure = setLog.isError ? (setLog.error as Error).message : null;

  // Tapping the row toggles the common case and nothing else: done, or back to
  // never-logged. Skipped, missed and notes live one tap deeper, in the sheet.
  //
  // Except when there is a note. Clearing a log deletes the row, and the note
  // goes with it — permanently, with the tick restored by the very next tap, so
  // nothing looks as though it went wrong. A note is writing, not a tick, and
  // the shallow gesture must not be able to destroy it; a habit carrying one
  // opens the sheet instead, where clearing is its own labelled button.
  const toggle = (habit: DayHabit) => {
    if (habit.status === "done" && habit.note) return setSheetFor(habit.id);
    setLog.mutate({ habit, status: habit.status === "done" ? null : "done" });
  };

  const open = habits.find((habit) => habit.id === sheetFor) ?? null;

  const rowProps = {
    readOnly,
    onToggle: toggle,
    onOpen: (habit: DayHabit) => setSheetFor(habit.id),
  };

  if (habits.length === 0) {
    return (
      <section aria-labelledby="habits-heading">
        <h2 id="habits-heading" className="sr-only">
          Habits
        </h2>
        <p className="font-serif text-name">Nothing tracked yet.</p>
        <p className="text-muted mt-2 max-w-sm">
          Start with one habit you actually want to keep. You can add more once it sticks.
        </p>
        <button type="button" onClick={onNewHabit} className={`${PRIMARY} mt-6 w-auto`}>
          Add the first habit
        </button>
      </section>
    );
  }

  return (
    <section aria-labelledby="habits-heading">
      <h2 id="habits-heading" className="sr-only">
        Habits
      </h2>

      {/* Three different days need three different sentences. Today is about
          what is still open; a past day has nothing open left, only a record; a
          day that has not happened has neither, only a plan. */}
      <p className="label text-muted flex flex-wrap gap-x-5 gap-y-1 pb-3">
        {total === 0 ? (
          <span>Nothing scheduled</span>
        ) : readOnly ? (
          <Pair k="scheduled" v={total} />
        ) : (
          <>
            <Pair k="logged" v={`${done} / ${total}`} />
            {!isToday || left === 0 ? null : <Pair k="left" v={left} />}
            {isToday && left === 0 ? <span>All done</span> : null}
          </>
        )}
      </p>

      <MarkKey />

      <ul>
        {asked.map((habit) => (
          <HabitRow
            key={habit.id}
            habit={habit}
            failure={habit.id === failedId ? failure : null}
            {...rowProps}
          />
        ))}
      </ul>

      {resting.length > 0 && (
        <details className="group">
          <summary className="label text-muted hover:text-ink flex min-h-11 cursor-pointer list-none items-center gap-2">
            <Chevron className="transition-transform group-open:rotate-90" />
            {resting.length} not scheduled{isToday ? " today" : ""}
          </summary>
          <ul>
            {resting.map((habit) => (
              <HabitRow
                key={habit.id}
                habit={habit}
                failure={habit.id === failedId ? failure : null}
                {...rowProps}
              />
            ))}
          </ul>
        </details>
      )}

      <button
        type="button"
        onClick={onNewHabit}
        className="label text-muted hover:text-ink border-baseline flex min-h-12 w-full items-center gap-2.5 border-t text-left transition-colors"
      >
        <span aria-hidden="true" className="text-name leading-none">
          +
        </span>
        New habit
      </button>

      {open && (
        <HabitSheet
          habit={open}
          date={date}
          readOnly={readOnly}
          onClose={() => setSheetFor(null)}
        />
      )}
    </section>
  );
}

/** A LABEL and its figure. The register's one repeated shape. */
const Pair = ({ k, v }: { k: string; v: string | number }) => (
  <span className="inline-flex items-baseline gap-2">
    {k}
    <span className="font-mono text-meta text-ink">{v}</span>
  </span>
);

// --- tasks -----------------------------------------------------------------

function TaskRow({
  task,
  date,
  overdue,
  future,
}: {
  task: Task;
  date: IsoDate;
  overdue: boolean;
  future: boolean;
}) {
  const patch = usePatchTask();
  const late = overdue && task.due_date ? daysBetween(task.due_date, date) : 0;

  return (
    <li className={`relative ${late > 0 ? "border-baseline" : "border-grid"} border-b`}>
      <label className="has-[:focus-visible]:outline-ink active:bg-raised flex min-h-12 cursor-pointer items-center gap-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2">
        <input
          type="checkbox"
          checked={task.completed}
          onChange={() => patch.mutate({ id: task.id, patch: { completed: !task.completed } })}
          className="sr-only"
        />
        <span
          aria-hidden="true"
          className={`grid h-3.5 w-3.5 shrink-0 place-items-center border-[1.5px] transition-colors ${
            // A finished task is the least important thing on the screen, so
            // its mark recedes with the rest of the row rather than shouting.
            task.completed
              ? "bg-muted border-muted text-canvas"
              : late > 0 && !future
                ? "border-warn"
                : "border-baseline"
          }`}
        >
          {task.completed && <Check />}
        </span>
        <span className={`flex-1 ${task.completed ? "text-muted line-through" : ""}`}>
          {task.title}
        </span>
        {late > 0 && !task.completed && (
          <span
            // On a day that has not arrived, being late is a forecast rather
            // than a fact, so it is stated without the warning colour.
            className={`label shrink-0 ${future ? "text-muted" : "text-warn"}`}
          >
            {/* And in the tense that goes with it. "3 days ago" is measured
                from the day on screen, so on a day still to come it dates the
                task from a future vantage point and reads as something that
                already happened. How late it will be by then is the same
                number, said forwards. */}
            {future
              ? `${late} ${late === 1 ? "day" : "days"} late`
              : late === 1
                ? "yesterday"
                : `${late} days ago`}
          </span>
        )}
      </label>
    </li>
  );
}

function AddTask({ date, today }: { date: IsoDate; today: IsoDate }) {
  const [title, setTitle] = useState("");
  const create = useCreateTask();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    // Adding a task while looking back at Tuesday should not create something
    // that is already overdue; anything earlier than today is due today.
    const due = date < today ? today : date;
    create.mutate({ title: title.trim(), due_date: due }, { onSuccess: () => setTitle("") });
  };

  return (
    <>
      <form onSubmit={submit} className="flex items-center gap-3">
        <span aria-hidden="true" className="text-faint text-name w-3.5 shrink-0 text-center">
          +
        </span>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
          placeholder="Add a task"
          aria-label="Add a task"
          className={FIELD}
        />
        {title.trim() && (
          <button
            type="submit"
            // Disabled while the request is in flight, or a second tap on a
            // slow connection files the same task twice — the title is still
            // in the box, because it is only cleared onSuccess.
            disabled={create.isPending}
            className="label min-h-11 shrink-0 px-2 disabled:opacity-40"
          >
            {create.isPending ? "Adding" : "Add"}
          </button>
        )}
      </form>

      {/* A task that failed to save left the title sitting in the box and said
          nothing, which looks exactly like a task that saved. */}
      {create.isError && (
        <p role="alert" className="text-warn text-meta mt-2">
          {(create.error as Error).message}
        </p>
      )}
    </>
  );
}

function Tasks({
  tasks,
  date,
  today,
  future,
}: {
  tasks: { due: Task[]; overdue: Task[] };
  date: IsoDate;
  today: IsoDate;
  future: boolean;
}) {
  const count = tasks.overdue.length + tasks.due.length;
  return (
    <section aria-labelledby="tasks-heading">
      <div className="border-baseline flex items-baseline justify-between gap-3 border-b pb-2">
        <h2 id="tasks-heading" className="label text-ink">
          Tasks
        </h2>
        <p className="label text-muted">
          {count === 0 ? "nothing due" : `${count} due`}
          {tasks.overdue.length > 0 ? ` · ${tasks.overdue.length} overdue` : ""}
        </p>
      </div>
      <ul className="mt-1">
        {tasks.overdue.map((task) => (
          <TaskRow key={task.id} task={task} date={date} overdue future={future} />
        ))}
        {tasks.due.map((task) => (
          <TaskRow key={task.id} task={task} date={date} overdue={false} future={future} />
        ))}
      </ul>
      <div className="mt-2">
        <AddTask date={date} today={today} />
      </div>
    </section>
  );
}

// --- the day's note --------------------------------------------------------

/**
 * Keyed on the date by its caller, so switching days remounts it and the
 * textarea starts from that day's entry rather than carrying the last one over.
 *
 * Saves on blur. On a phone, leaving the app blurs the field, which is exactly
 * when an autosave would want to fire anyway.
 */
function Note({
  date,
  entry,
  readOnly,
}: {
  date: IsoDate;
  entry: JournalEntry | null;
  readOnly: boolean;
}) {
  const saved = entry?.entry ?? "";
  const [text, setText] = useState(saved);
  const save = useSaveJournal(date);

  const dirty = text.trim() !== saved;

  return (
    <section aria-labelledby="note-heading">
      <div className="border-baseline flex items-baseline justify-between gap-3 border-b pb-2">
        <h2 id="note-heading" className="label text-ink">
          Note
        </h2>
        <p aria-live="polite" className="label text-muted">
          {save.isPending ? "saving" : save.isError ? "" : dirty ? "unsaved" : ""}
        </p>
      </div>

      <textarea
        value={text}
        rows={4}
        maxLength={10_000}
        onChange={(event) => setText(event.target.value)}
        disabled={readOnly}
        onBlur={() => dirty && save.mutate(text)}
        placeholder={readOnly ? "Nothing to write yet." : "What happened?"}
        aria-label="Notes for this day"
        className="ruled placeholder:text-faint mt-3 w-full max-w-[60ch] resize-y"
      />

      {save.isError && (
        <p role="alert" className="text-warn text-meta mt-1">
          {(save.error as Error).message}
        </p>
      )}
    </section>
  );
}

// --- the date axis ---------------------------------------------------------

/**
 * A scale of the days around this one, with the pen at today.
 *
 * It is a POINTER SHORTCUT and nothing else — aria-hidden, no focusable
 * children — which is the same decision the sheet's cells already carry, for
 * the same reason: a month of tab stops that a screen reader cannot name is
 * worse than none. The addressable route to any day is the date field and the
 * two steppers beside it, and those are unchanged.
 */
function DayAxis({
  date,
  today,
  onPick,
}: {
  date: IsoDate;
  today: IsoDate;
  onPick: (date: IsoDate) => void;
}) {
  const SPAN = 29;
  const AHEAD = 4;
  const days = Array.from({ length: SPAN }, (_unused, index) =>
    addDays(today, index - (SPAN - 1 - AHEAD)),
  );

  return (
    <div
      aria-hidden="true"
      onClick={(event) => {
        const picked = (event.target as HTMLElement).closest<HTMLElement>("[data-date]")?.dataset
          .date;
        if (picked) onPick(picked);
      }}
      className="border-baseline relative h-11 border-b"
    >
      {days.map((day, index) => {
        const left = `${(index / (SPAN - 1)) * 100}%`;
        // Week majors are Mondays, matching the product's Monday week start.
        const monday = isoWeekday(day) === 1;
        const first = day.slice(8) === "01";
        const height = first ? 15 : monday ? 9 : 5;
        return (
          <span key={day}>
            {/* A 44px tap target over a 5px tick. */}
            <span
              data-date={day}
              className="absolute bottom-0 h-11 w-[3.4%] cursor-pointer"
              style={{ left, transform: "translateX(-50%)" }}
            />
            <span
              className={`pointer-events-none absolute bottom-0 w-px ${
                first || monday ? "bg-baseline" : "bg-faint"
              }`}
              style={{ left, height }}
            />
            {first && (
              <span
                className="label-tick text-muted pointer-events-none absolute bottom-4 whitespace-nowrap"
                style={{ left: `calc(${left} + 3px)` }}
              >
                {formatMonthShort(day)}
              </span>
            )}
            {day === today && (
              <span
                className="pointer-events-none absolute bottom-0 h-0 w-0"
                style={{
                  left,
                  transform: "translateX(-50%)",
                  borderLeft: "5px solid transparent",
                  borderRight: "5px solid transparent",
                  borderBottom: "8px solid var(--c-ink)",
                }}
              />
            )}
            {day === date && day !== today && (
              <span
                className="border-ink pointer-events-none absolute bottom-0.5 h-2 w-2 border-[1.5px]"
                style={{ left, transform: "translateX(-50%)" }}
              />
            )}
          </span>
        );
      })}
    </div>
  );
}

// --- the screen ------------------------------------------------------------

const DaySkeleton = () => (
  <div className="grid gap-4 pt-2">
    {[0, 1, 2, 3].map((row) => (
      <Skeleton key={row} className="h-14" />
    ))}
  </div>
);

export default function Day() {
  const { date: param } = useParams();
  const navigate = useNavigate();
  const date = param ?? browserToday();

  const query = useDay(date);
  const [newHabit, setNewHabit] = useState(false);

  const data = query.data;
  const today = data?.today;

  /**
   * The server decides what day it is, in APP_TIMEZONE. When "/" lands on a
   * date the server disagrees with — a browser in another zone, or a tab left
   * open past midnight — move to the server's today rather than quietly
   * showing the wrong day.
   */
  useEffect(() => {
    if (!param && today && today !== date) navigate(`/day/${today}`, { replace: true });
  }, [param, today, date, navigate]);

  // On a desktop, stepping through days should not mean reaching for the mouse.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      ) {
        return;
      }
      if (event.key === "[") navigate(`/day/${addDays(date, -1)}`);
      else if (event.key === "]" && today && date < today) navigate(`/day/${addDays(date, 1)}`);
      else if (event.key === "t" && today) navigate(`/day/${today}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [date, today, navigate]);

  const isToday = today ? date === today : false;
  const readOnly = today ? date > today : false;
  const relative = today ? relativeDay(date, today) : null;

  /* Derived from the date on screen and nothing else — no new payload field.
     An instrument says where in the run you are. */
  const dayOfYear = daysBetween(`${date.slice(0, 4)}-01-01`, date) + 1;

  /*
   * ONE instance, placed by the grid — never a second copy behind an `lg:hidden`.
   * Two copies duplicate every id on the page, and the hidden one is the first
   * in document order, so `h1` resolves to something that is not on screen.
   *
   * The whole block is the heading, with its accessible name given outright:
   * read out, "September 2026, 16, Wed, 2026" is three fragments of one date,
   * and the date is what this screen is called.
   */
  const identity = (
    <>
      <h1 aria-label={formatDateLong(date)}>
        <span aria-hidden="true" className="label text-muted block">
          {formatMonthLong(monthOf(date))}
        </span>
        {/*
         * THE figure: the day of the month, and the only thing on any screen
         * set this large. A date is what this screen is addressed by, and a
         * numeral is what a register displays — the weekday is a word, and a
         * word set at 76px is a headline rather than a readout. It sits
         * directly under the figure in ink rather than in the muted label
         * above it, because which weekday it is decides whether a fixed habit
         * was asked of you at all.
         */}
        <span
          aria-hidden="true"
          className="font-mono text-fig text-ink mt-2 block font-semibold tracking-[-0.05em]"
        >
          {Number(date.slice(8))}
        </span>
        <span aria-hidden="true" className="label text-ink mt-2.5 block">
          {formatWeekday(date)} · {date.slice(0, 4)}
        </span>
      </h1>
      <p className="label text-muted mt-4 flex flex-wrap gap-x-5 gap-y-1">
        <Pair k="day" v={`${dayOfYear} / ${Number(date.slice(0, 4)) % 4 === 0 ? 366 : 365}`} />
        {relative && <span>{relative}</span>}
        {!relative && <span>{readOnly ? "Coming up" : "Looking back"}</span>}
      </p>
    </>
  );

  const steppers = (
    <nav aria-label="Change day" className="flex shrink-0 items-center gap-2">
      {/*
       * The only way to an arbitrary day that does not involve pressing
       * "Previous day" once per day between here and there. The axis above
       * looks like the answer but is not one: it is aria-hidden and its ticks
       * are a click handler on a span, so a keyboard or a screen reader could
       * reach no day but this one.
       *
       * <input type="date"> rather than a calendar of our own, for the reason
       * the sheet is a <dialog>: the platform ships a picker that is already
       * localised, already keyboard-operable and already the one the phone's
       * owner knows.
       */}
      <input
        type="date"
        value={date}
        aria-label="Go to date"
        onChange={(event) => event.target.value && navigate(`/day/${event.target.value}`)}
        className="border-baseline focus:border-ink font-mono text-meta h-11 w-[8.5rem] border-b bg-transparent outline-none"
      />
      {!isToday && today && (
        <button
          type="button"
          onClick={() => navigate(`/day/${today}`)}
          className="label min-h-11 px-1"
        >
          Today
        </button>
      )}
      <button
        type="button"
        aria-label="Previous day"
        onClick={() => navigate(`/day/${addDays(date, -1)}`)}
        className={ICON_BUTTON}
      >
        <Chevron className="rotate-180" />
      </button>
      <button
        type="button"
        aria-label="Next day"
        disabled={!today || date >= today}
        onClick={() => navigate(`/day/${addDays(date, 1)}`)}
        className={ICON_BUTTON}
      >
        <Chevron />
      </button>
    </nav>
  );

  return (
    <div className="mx-auto w-full max-w-[84rem] px-4 pb-16 sm:px-6 lg:px-8">
      {/*
       * The identity column. On a wide screen the figure and the first channel
       * share a top line, which is what stops the screen reading as a title
       * stacked above a list — and the heading is ONE element, moved by grid
       * placement rather than duplicated behind a breakpoint. Source order
       * stays the phone's, so the heading is never moved away from what it
       * names.
       */}
      <div
        // Keeps the previous day on screen while the next one loads, so
        // stepping days never blanks the layout — dimmed, not pretending.
        className={`transition-opacity lg:grid lg:grid-cols-[14.5rem_minmax(0,36rem)_minmax(0,17rem)] lg:items-start lg:gap-x-11 lg:pt-16 xl:gap-x-14 ${
          query.isPlaceholderData ? "opacity-50" : "opacity-100"
        }`}
      >
        <header className="pt-6 pb-6 sm:pt-10 lg:col-start-1 lg:row-start-1 lg:pt-0 lg:pb-0">
          {identity}
        </header>

        {query.isError && !data ? (
          <div className="lg:col-start-2 lg:row-start-1">
            <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
          </div>
        ) : !data ? (
          <div className="lg:col-start-2 lg:row-start-1">
            <DaySkeleton />
          </div>
        ) : (
          <main className="contents">
            <div className="lg:col-start-2 lg:row-start-1">
              <DayAxis
                date={date}
                today={data.today}
                onPick={(picked) => navigate(`/day/${picked}`)}
              />
              <div className="flex justify-end pt-2 pb-5">{steppers}</div>

              <Habits
                habits={data.habits}
                date={date}
                isToday={isToday}
                readOnly={readOnly}
                onNewHabit={() => setNewHabit(true)}
              />
            </div>

            <div className="mt-12 lg:col-start-3 lg:row-start-1 lg:mt-0 lg:pt-1">
              <Tasks tasks={data.tasks} date={date} today={data.today} future={readOnly} />
            </div>

            <div className="mt-12 lg:col-start-2 lg:row-start-2 lg:mt-14">
              <Note key={date} date={date} entry={data.journal} readOnly={readOnly} />
            </div>
          </main>
        )}
      </div>

      {/* Named as shortcuts, because two bracket characters in a sentence read
          as punctuation rather than as keys to press. Hidden below md: a phone
          has no keyboard to offer them on. */}
      <footer className="border-grid text-meta text-muted mt-16 hidden border-t pt-5 md:block">
        <p>
          <span className="label">Keyboard</span> — press <kbd className="font-mono">[</kbd> or{" "}
          <kbd className="font-mono">]</kbd> to move to the day before or after, and{" "}
          <kbd className="font-mono">t</kbd> to come back to today.
        </p>
      </footer>

      <NewHabitDialog
        open={newHabit}
        onClose={() => setNewHabit(false)}
        taken={(data?.habits ?? []).map((habit) => habit.color_token)}
      />
    </div>
  );
}
