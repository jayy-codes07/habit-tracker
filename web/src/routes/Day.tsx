/**
 * The Day screen — and, with the date set to today, the whole of "Today".
 *
 * There is no separate Today screen on purpose. Logging this morning and fixing
 * last Tuesday are the same job, so they are the same screen with a different
 * date, and GET /api/day/:date paints all of it in one request: habits with
 * their state and streaks, the tasks that were due, and the day's note.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";

import { ErrorBox } from "../components/ErrorBox";
import { ICON_BUTTON } from "../components/form";
import { Check, Chevron, Cross, Dash, Ellipsis } from "../components/icons";
import { Skeleton } from "../components/Skeleton";
import { HabitSheet } from "../features/habits/HabitSheet";
import { NewHabitDialog } from "../features/habits/NewHabitDialog";
import { useSetLog } from "../features/habits/queries";
import {
  isActionable,
  markOf,
  metaLine,
  stateLabel,
  summarise,
  type Mark,
} from "../features/habits/verdict";
import { useSaveJournal } from "../features/journal/queries";
import { useDay } from "../features/overview/queries";
import { useCreateTask, usePatchTask } from "../features/tasks/queries";
import { addDays, browserToday, daysBetween, formatDateLong, relativeDay } from "../lib/dates";
import type { ColorToken, DayHabit, IsoDate, JournalEntry, Task } from "../types";

/**
 * The state of one habit on one day, as fill and shape rather than colour alone
 * — a habit's colour identifies the habit, never how the day went. Missed is
 * the only warm mark in the list, and it is a hollow outline: a tracker that
 * shouts at you is a tracker you stop opening.
 */
function Mark({ mark, color }: { mark: Mark; color: ColorToken }) {
  const tint = `var(--c-${color})`;
  const base = "grid h-7 w-7 shrink-0 place-items-center rounded-lg border-2 transition-colors";

  switch (mark) {
    case "done":
      return (
        <span
          className={base}
          style={{ background: tint, borderColor: tint, color: "var(--c-canvas)" }}
        >
          <Check />
        </span>
      );
    case "extra": {
      const soft = `color-mix(in srgb, ${tint} 40%, transparent)`;
      return (
        <span className={base} style={{ background: soft, borderColor: soft }}>
          <Check />
        </span>
      );
    }
    case "skipped":
      return (
        <span className={`${base} bg-line border-line text-muted`}>
          <Dash />
        </span>
      );
    case "missed":
      return (
        <span className={`${base} border-warn text-warn`}>
          <Cross />
        </span>
      );
    default:
      return <span className={`${base} border-line-strong`} />;
  }
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

  return (
    <li className="border-line/70 border-b last:border-b-0">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-pressed={habit.status === "done"}
          disabled={readOnly}
          onClick={() => onToggle(habit)}
          className="active:bg-raised -mx-2 flex min-h-14 flex-1 items-center gap-3 rounded-lg px-2 text-left transition-colors disabled:opacity-55"
        >
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 shrink-0 rounded-full"
            style={{ background: `var(--c-${habit.color_token})` }}
          />
          <span className="min-w-0 flex-1 lg:flex lg:items-baseline lg:gap-4">
            <span className="text-row block truncate font-medium lg:flex-1">{habit.name}</span>
            {meta && <span className="text-meta text-muted block lg:shrink-0">{meta}</span>}
          </span>
          <span className="sr-only">, {stateLabel(habit)}</span>
          <Mark mark={markOf(habit)} color={habit.color_token} />
        </button>

        <button
          type="button"
          onClick={() => onOpen(habit)}
          aria-label={`More options for ${habit.name}`}
          className="text-muted hover:text-ink hover:bg-raised grid h-11 w-9 shrink-0 place-items-center rounded-lg transition-colors"
        >
          <Ellipsis />
        </button>
      </div>

      {habit.note && !failure && (
        <p className="text-muted pb-3 pl-[1.375rem] font-serif">{habit.note}</p>
      )}

      {/* A failed tick has already rolled back. The explanation belongs on the
          row that failed, not in a corner of the screen. */}
      {failure && (
        <p role="alert" className="text-warn text-meta pb-3 pl-[1.375rem]">
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

  // Three different days need three different sentences. Today is about what
  // is still open; a past day has nothing open left, only a record; a day that
  // has not happened has neither, only a plan.
  const summary =
    total === 0
      ? "Nothing scheduled"
      : readOnly
        ? `${total} scheduled`
        : !isToday
          ? `${done} of ${total} done`
          : left === 0
            ? "All done"
            : done === 0
              ? `${left} to do`
              : `${done} done, ${left} left`;

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
        <p className="text-row">Nothing tracked yet.</p>
        <p className="text-muted mt-1 max-w-sm">
          Start with one habit you actually want to keep. You can add more once it sticks.
        </p>
        <button
          type="button"
          onClick={onNewHabit}
          className="bg-ink text-canvas mt-5 min-h-12 rounded-lg px-5 font-semibold"
        >
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

      <p className="text-meta text-muted tabular pb-1">{summary}</p>

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
        <details className="group border-line mt-1 border-t pt-1">
          <summary className="text-meta text-muted hover:text-ink flex min-h-11 cursor-pointer list-none items-center gap-1.5">
            <Chevron className="transition-transform group-open:rotate-90" />
            {resting.length} not scheduled{isToday ? " today" : ""}
          </summary>
          <ul className="opacity-80">
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
        className="text-muted hover:text-ink border-line mt-1 flex min-h-12 w-full items-center gap-2 border-t text-left transition-colors"
      >
        <span aria-hidden="true" className="text-row leading-none">
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
    <li className="border-line/70 border-b last:border-b-0">
      <label className="has-[:focus-visible]:outline-ink active:bg-raised -mx-2 flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-2 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2">
        <input
          type="checkbox"
          checked={task.completed}
          onChange={() => patch.mutate({ id: task.id, patch: { completed: !task.completed } })}
          className="sr-only"
        />
        <span
          aria-hidden="true"
          className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 transition-colors ${
            // A finished task is the least important thing on the screen, so
            // its mark recedes with the rest of the row rather than shouting.
            task.completed ? "bg-muted border-muted text-canvas" : "border-line-strong"
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
            className={`text-meta tabular shrink-0 ${future ? "text-muted" : "text-warn"}`}
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
    <form onSubmit={submit} className="border-line mt-1 flex items-center gap-2 border-t">
      <span
        aria-hidden="true"
        className="text-muted text-row w-5 shrink-0 text-center leading-none"
      >
        +
      </span>
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        maxLength={200}
        placeholder="Add a task"
        aria-label="Add a task"
        className="placeholder:text-muted min-h-12 flex-1 bg-transparent outline-none"
      />
      {title.trim() && (
        <button type="submit" className="text-meta min-h-11 shrink-0 px-2 font-semibold">
          {create.isPending ? "Adding…" : "Add"}
        </button>
      )}
    </form>
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
  return (
    <section aria-labelledby="tasks-heading">
      <h2 id="tasks-heading" className="text-section pb-1 font-semibold tracking-[-0.01em]">
        Tasks
      </h2>
      {tasks.overdue.length === 0 && tasks.due.length === 0 && (
        <p className="text-meta text-muted pb-1">Nothing due.</p>
      )}
      <ul>
        {tasks.overdue.map((task) => (
          <TaskRow key={task.id} task={task} date={date} overdue future={future} />
        ))}
        {tasks.due.map((task) => (
          <TaskRow key={task.id} task={task} date={date} overdue={false} future={future} />
        ))}
      </ul>
      <AddTask date={date} today={today} />
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
      <div className="flex items-baseline justify-between gap-3 pb-1">
        <h2 id="note-heading" className="text-section font-semibold tracking-[-0.01em]">
          Notes
        </h2>
        <p aria-live="polite" className="text-meta text-muted">
          {save.isPending ? "Saving…" : save.isError ? "" : dirty ? "Unsaved" : ""}
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

// --- the screen ------------------------------------------------------------

const DaySkeleton = () => (
  <div className="grid gap-3 pt-2">
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

  return (
    <div className="mx-auto w-full max-w-[68rem] px-4 pb-20 sm:px-6 lg:px-8">
      {/* Capped to the main column so the day steppers stay next to the
          date instead of drifting to the far edge of a wide screen. */}
      <header className="pt-5 pb-7 sm:pt-8 lg:max-w-[46rem]">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <p className="text-meta text-muted">
            {/* The server decides which day is today, so say nothing until it has. */}
            {today ? (relative ?? (readOnly ? "Coming up" : "Looking back")) : ""}
          </p>

          <nav aria-label="Change day" className="flex shrink-0 items-center gap-1.5">
            {/*
             * The only way to an arbitrary day that does not involve pressing
             * "Previous day" once per day between here and there. The grid's
             * squares look like the answer but are not one: that grid is
             * aria-hidden and its cells are a click handler on a div, so a
             * keyboard or a screen reader could reach no day but this one.
             *
             * <input type="date"> rather than a calendar of our own, for the
             * reason the sheet is a <dialog>: the platform ships a picker that
             * is already localised, already keyboard-operable and already the
             * one the phone's owner knows.
             *
             * It is deliberately not capped at today. The steppers stay bounded
             * to days that have been lived — "Next day" stops at today, and
             * walking into next year one tap at a time is not navigation — but
             * a day you name outright is a destination, and the screen renders
             * one that has not arrived read-only and says "Coming up".
             */}
            <input
              type="date"
              value={date}
              aria-label="Go to date"
              onChange={(event) => event.target.value && navigate(`/day/${event.target.value}`)}
              className="border-line-strong bg-canvas text-meta tabular focus:border-ink h-11 rounded-lg border px-2 outline-none"
            />
            {!isToday && today && (
              <button
                type="button"
                onClick={() => navigate(`/day/${today}`)}
                className="border-line-strong hover:bg-raised text-meta min-h-11 rounded-lg border px-3 font-medium"
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
        </div>

        <h1 className="font-serif text-date mt-1 tracking-[-0.015em]">{formatDateLong(date)}</h1>
      </header>

      {query.isError && !data ? (
        <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
      ) : !data ? (
        <DaySkeleton />
      ) : (
        <div
          // Keeps the previous day on screen while the next one loads, so
          // stepping days never blanks the layout — dimmed, not pretending.
          className={`transition-opacity lg:grid lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start lg:gap-x-12 xl:gap-x-16 ${
            query.isPlaceholderData ? "opacity-50" : "opacity-100"
          }`}
        >
          {/* Source order is the phone's order — habits, then tasks, then the
              note to close the day out. On a wide screen the grid moves the
              note under the habits, where it has room to be written in, and
              gives tasks the side column. One instance of each: a second copy
              behind a lg:hidden would duplicate every element id on the page. */}
          <main className="contents">
            <div className="lg:col-start-1 lg:row-start-1">
              <Habits
                habits={data.habits}
                date={date}
                isToday={isToday}
                readOnly={readOnly}
                onNewHabit={() => setNewHabit(true)}
              />
            </div>

            <div className="mt-10 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:mt-0">
              <Tasks tasks={data.tasks} date={date} today={data.today} future={readOnly} />
            </div>

            <div className="mt-10 lg:col-start-1 lg:row-start-2 lg:mt-12">
              <Note key={date} date={date} entry={data.journal} readOnly={readOnly} />
            </div>
          </main>
        </div>
      )}

      {/* Sign out moved to the tab bar; what is left is a desktop hint, so the
          whole footer goes with it rather than leaving a rule across a phone. */}
      <footer className="border-line text-meta text-muted mt-16 hidden border-t pt-5 lg:block">
        <p>
          <kbd className="tabular">[</kbd> and <kbd className="tabular">]</kbd> move between days,{" "}
          <kbd>t</kbd> returns to today.
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
