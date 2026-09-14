/**
 * The Tasks screen — everything on the list, as opposed to what one day asks of
 * you.
 *
 * Day already shows the tasks that were due, and that is the right thing there:
 * it answers "what does today want". This answers the other question, "what is
 * on my plate at all", and it is the only place two thirds of the task model is
 * reachable — a task with no date, a task that needs rewording, a task that
 * should not exist. GET /api/tasks is not called anywhere else in the app.
 *
 * Four groups, because each answers a different question and the server's own
 * ordering already implies them (completed, then due_date NULLS LAST, then
 * created_at):
 *
 *   Overdue  — you said when, and the when has passed
 *   Scheduled — you said when, and it has not
 *   Anytime  — you never said when, which is a decision, not an omission
 *   Done     — folded away, because a finished task is the least urgent thing
 *              on the screen
 *
 * Nothing here is rolled forward and no due date is ever rewritten, matching
 * the server: a task keeps saying when it was actually meant to happen.
 */
import { useState, type FormEvent } from "react";

import { ErrorBox } from "../components/ErrorBox";
import { Check, Chevron } from "../components/icons";
import { Skeleton } from "../components/Skeleton";
import { TaskEditor } from "../features/tasks/TaskEditor";
import { useCreateTask, usePatchTask, useTasks } from "../features/tasks/queries";
import {
  browserToday,
  daysBetween,
  formatDateShort,
  formatWeekday,
  relativeDay,
} from "../lib/dates";
import type { Id, IsoDate, Task } from "../types";

/**
 * When a dated task is due, in as few words as it deserves.
 *
 * `today` is the browser's, which is the same compromise /review makes and for
 * the same reason: there is no server `today` in this payload, and being a few
 * hours out at a boundary mislabels a chip. Nothing here writes a date, so the
 * worst case is a task that reads as due today for one evening.
 */
function dueLabel(due: IsoDate, today: IsoDate): string {
  const relative = relativeDay(due, today);
  if (relative) return relative;

  const days = daysBetween(today, due);
  if (days < 0) return `${-days} days ago`;
  // Inside the coming week the weekday is the useful name. Trimming the year off
  // formatDateShort would be a guess about where the locale put it.
  if (days < 7) return formatWeekday(due);
  return formatDateShort(due);
}

function TaskRow({
  task,
  today,
  overdue,
  onOpen,
}: {
  task: Task;
  today: IsoDate;
  overdue: boolean;
  onOpen: () => void;
}) {
  const patch = usePatchTask();

  return (
    <li className="border-line/70 flex items-center gap-1 border-b last:border-b-0">
      {/* The checkbox is its own label so ticking never opens the sheet, and
          the title is its own button so opening never ticks. Two targets, two
          jobs — the mistake is expensive in both directions. */}
      <label className="has-[:focus-visible]:outline-ink active:bg-raised -ml-2 grid h-12 w-10 shrink-0 cursor-pointer place-items-center rounded-lg transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2">
        <input
          type="checkbox"
          checked={task.completed}
          onChange={() => patch.mutate({ id: task.id, patch: { completed: !task.completed } })}
          aria-label={task.completed ? `Mark ${task.title} as not done` : `Complete ${task.title}`}
          className="sr-only"
        />
        <span
          aria-hidden="true"
          className={`grid h-5 w-5 place-items-center rounded-full border-2 transition-colors ${
            task.completed ? "bg-muted border-muted text-canvas" : "border-line-strong"
          }`}
        >
          {task.completed && <Check />}
        </span>
      </label>

      <button
        type="button"
        onClick={onOpen}
        className="active:bg-raised flex min-h-12 flex-1 items-center gap-3 rounded-lg px-2 text-left transition-colors"
      >
        <span className={`flex-1 ${task.completed ? "text-muted line-through" : ""}`}>
          {task.title}
        </span>
        {task.due_date && !task.completed && (
          <span className={`text-meta tabular shrink-0 ${overdue ? "text-warn" : "text-muted"}`}>
            {dueLabel(task.due_date, today)}
          </span>
        )}
        <Chevron className="text-muted shrink-0" />
      </button>
    </li>
  );
}

function Group({
  heading,
  tasks,
  today,
  overdue = false,
  onOpen,
}: {
  heading: string;
  tasks: Task[];
  today: IsoDate;
  overdue?: boolean;
  onOpen: (task: Task) => void;
}) {
  if (tasks.length === 0) return null;
  const id = `group-${heading.toLowerCase()}`;

  return (
    <section aria-labelledby={id} className="mt-7 first:mt-0">
      <h2 id={id} className={`text-meta pb-1 font-medium ${overdue ? "text-warn" : "text-muted"}`}>
        {heading}
      </h2>
      <ul>
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            today={today}
            overdue={overdue}
            onOpen={() => onOpen(task)}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * Adding a task here deliberately does NOT default a due date, which is the one
 * thing Day's version cannot do. A date is a commitment; making the quick-add
 * invent one turns every stray thought into something that will be overdue by
 * Thursday.
 */
function AddTask() {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState<IsoDate | "">("");
  const create = useCreateTask();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    create.mutate(
      { title: title.trim(), due_date: due === "" ? null : due },
      {
        onSuccess: () => {
          setTitle("");
          setDue("");
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="border-line mb-7 border-b pb-5">
      <div className="flex items-center gap-2">
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
        <button
          type="submit"
          disabled={!title.trim() || create.isPending}
          className="text-meta min-h-11 shrink-0 px-2 font-semibold disabled:opacity-30"
        >
          {create.isPending ? "Adding…" : "Add"}
        </button>
      </div>

      {/* Offered, never assumed — and only once there is something to date. */}
      {title.trim() && (
        <div className="mt-1 flex items-center gap-2 pl-7">
          <label htmlFor="new-task-due" className="text-meta text-muted shrink-0">
            Due
          </label>
          <input
            id="new-task-due"
            type="date"
            value={due}
            onChange={(event) => setDue(event.target.value)}
            className="border-line-strong bg-canvas text-field min-h-11 rounded-lg border px-3 outline-none"
          />
          {due === "" && <span className="text-meta text-muted">optional</span>}
        </div>
      )}

      {create.isError && (
        <p role="alert" className="text-warn text-meta mt-1 pl-7">
          {create.error.message}
        </p>
      )}
    </form>
  );
}

const TasksSkeleton = () => (
  <div className="grid gap-3 pt-2">
    {[0, 1, 2, 3].map((row) => (
      <Skeleton key={row} className="h-12" />
    ))}
  </div>
);

export default function Tasks() {
  // "all" rather than "open": the done list is part of this screen, and one
  // request that carries both beats two that have to agree with each other.
  const query = useTasks("all");
  // The recovery list. Its own query rather than a filter of the one above,
  // because scope=archived is a different view of the table, not a subset —
  // "all" deliberately excludes archived tasks.
  const removedQuery = useTasks("archived");
  const patch = usePatchTask();

  const [editing, setEditing] = useState<Id | null>(null);
  const [removed, setRemoved] = useState<Task | null>(null);

  const today = browserToday();
  const tasks = query.data ?? [];
  const archived = removedQuery.data ?? [];

  const open = tasks.filter((task) => !task.completed);
  const done = tasks.filter((task) => task.completed);

  const overdue = open.filter((task) => task.due_date !== null && task.due_date < today);
  const scheduled = open.filter((task) => task.due_date !== null && task.due_date >= today);
  const anytime = open.filter((task) => task.due_date === null);

  const editingTask = tasks.find((task) => task.id === editing) ?? null;

  return (
    <div className="mx-auto w-full max-w-[68rem] px-4 pb-20 sm:px-6 lg:px-8">
      <header className="pt-5 pb-7 sm:pt-8 lg:max-w-[46rem]">
        <p className="text-meta text-muted">
          {open.length === 0
            ? done.length === 0
              ? "Nothing on the list"
              : "Nothing left"
            : `${open.length} open${overdue.length > 0 ? ` · ${overdue.length} overdue` : ""}`}
        </p>
        <h1 className="font-serif text-date mt-1 tracking-[-0.015em]">Tasks</h1>
      </header>

      {query.isError && !query.data ? (
        <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <TasksSkeleton />
      ) : (
        <main className="lg:max-w-[46rem]">
          <AddTask />

          {/* Removing is reversible only right here: no endpoint lists archived
              tasks, so this is the last moment the id is in reach. It waits
              rather than timing out — a bar that vanishes on its own takes the
              only way back with it — but it must be dismissable, or the one
              answer the screen accepts is "undo". */}
          {removed && (
            <div
              role="status"
              className="border-line bg-surface mb-5 flex items-center gap-1 rounded-xl border py-1 pr-1 pl-4"
            >
              <p className="text-meta flex-1 truncate">Removed “{removed.title}”.</p>
              <button
                type="button"
                disabled={patch.isPending}
                onClick={() =>
                  patch.mutate(
                    { id: removed.id, patch: { archived: false } },
                    { onSuccess: () => setRemoved(null) },
                  )
                }
                className="text-meta min-h-11 shrink-0 px-2 font-semibold underline underline-offset-4"
              >
                {patch.isPending ? "Undoing…" : "Undo"}
              </button>
              <button
                type="button"
                onClick={() => setRemoved(null)}
                aria-label="Dismiss"
                className="text-muted hover:text-ink hover:bg-raised grid h-11 w-9 shrink-0 place-items-center rounded-lg transition-colors"
              >
                <svg
                  viewBox="0 0 16 16"
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
          )}

          {/* The empty state counts removed tasks too: "nothing on the list" is
              false when there is a drawer of them to restore from. */}
          {open.length === 0 && done.length === 0 && archived.length === 0 ? (
            <p className="text-muted max-w-sm">
              Nothing on the list. Add what you would otherwise keep remembering.
            </p>
          ) : (
            <>
              <Group
                heading="Overdue"
                tasks={overdue}
                today={today}
                overdue
                onOpen={(task) => setEditing(task.id)}
              />
              <Group
                heading="Scheduled"
                tasks={scheduled}
                today={today}
                onOpen={(task) => setEditing(task.id)}
              />
              <Group
                heading="Anytime"
                tasks={anytime}
                today={today}
                onOpen={(task) => setEditing(task.id)}
              />

              {done.length > 0 && (
                <details className="group border-line mt-8 border-t pt-1">
                  <summary className="text-meta text-muted hover:text-ink flex min-h-11 cursor-pointer list-none items-center gap-1.5">
                    <Chevron className="transition-transform group-open:rotate-90" />
                    {done.length === 1 ? "One done" : `${done.length} done`}
                  </summary>
                  <ul className="opacity-70">
                    {done.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        today={today}
                        overdue={false}
                        onOpen={() => setEditing(task.id)}
                      />
                    ))}
                  </ul>
                </details>
              )}

              {/* Removed tasks, folded away below Done. The undo bar above
                  catches the slip you notice immediately; this is the way back
                  to one you notice next week. Rows are not TaskRow: a removed
                  task cannot be ticked, edited or removed again, and offering
                  those controls would only make it look like it was still on
                  the list. */}
              {archived.length > 0 && (
                <details className="group border-line mt-2 border-t pt-1">
                  <summary className="text-meta text-muted hover:text-ink flex min-h-11 cursor-pointer list-none items-center gap-1.5">
                    <Chevron className="transition-transform group-open:rotate-90" />
                    {archived.length === 1 ? "One removed" : `${archived.length} removed`}
                  </summary>
                  <ul>
                    {archived.map((task) => (
                      <li
                        key={task.id}
                        className="border-line/70 flex items-center gap-3 border-b py-2 last:border-b-0"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="text-muted block truncate">{task.title}</span>
                          {task.archived_at && (
                            <span className="text-micro text-muted">
                              {/* archived_at is an instant; only the day it fell
                                  on is worth showing, and the cheapest correct
                                  way to that is the date the server sent. */}
                              Removed {formatDateShort(task.archived_at.slice(0, 10))}
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          disabled={patch.isPending}
                          onClick={() =>
                            patch.mutate(
                              { id: task.id, patch: { archived: false } },
                              {
                                // The same task can be in both places at once.
                                // Restoring it here must not leave the undo bar
                                // still offering to undo what just happened.
                                onSuccess: () =>
                                  setRemoved((current) =>
                                    current?.id === task.id ? null : current,
                                  ),
                              },
                            )
                          }
                          className="border-line-strong hover:bg-raised text-meta min-h-11 shrink-0 rounded-lg border px-3 font-medium disabled:opacity-40"
                        >
                          Restore
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </main>
      )}

      {editingTask && (
        <TaskEditor task={editingTask} onClose={() => setEditing(null)} onRemoved={setRemoved} />
      )}
    </div>
  );
}
