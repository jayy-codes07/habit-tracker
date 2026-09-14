/**
 * The Habits screen — the only place the habits themselves are managed, as
 * opposed to the days they are kept on.
 *
 * The split is the whole point of having this screen at all. Day is for
 * logging: fast, one tap, never asking you to think about a schedule while you
 * are trying to tick something off. This is for deciding: what you track, what
 * it is called, how often, in what order, and what to do with the ones you have
 * finished with. Mixing the two is what turns a tracker into an admin panel.
 *
 * Nothing here is scored. There is not a streak or a percentage on the screen —
 * those are Grid's and Review's job, and a management list that also grades you
 * is a list you edit defensively.
 *
 * Settings live at the bottom rather than behind a fourth tab: there are two of
 * them, and the one thing a person will look for after "where are my habits" is
 * "where is my data".
 */
import { useState } from "react";

import { ErrorBox } from "../components/ErrorBox";
import { Choice } from "../components/Choice";
import { Chevron } from "../components/icons";
import { Skeleton } from "../components/Skeleton";
import { HabitEditor } from "../features/habits/HabitEditor";
import { NewHabitDialog } from "../features/habits/NewHabitDialog";
import { useHabits, useReorderHabits } from "../features/habits/queries";
import { scheduleWords } from "../features/habits/verdict";
import { formatDateShort } from "../lib/dates";
import { applyTheme, readTheme, type Theme } from "../lib/theme";
import type { Habit, Id } from "../types";

const ICON_BUTTON =
  "border-line-strong hover:bg-raised text-ink grid h-11 w-11 place-items-center rounded-lg border transition-colors disabled:opacity-30 disabled:hover:bg-transparent";

/**
 * The one line under a habit's name: what is being asked of it.
 *
 * A habit whose start date has not arrived resolves to no schedule at all — the
 * server reports `schedule: null` rather than the version waiting behind it —
 * so that case says when it begins instead of saying nothing.
 */
function summary(habit: Habit): string {
  if (!habit.schedule) return `Starts ${formatDateShort(habit.start_date)}`;
  const { schedule_kind: kind, schedule_days: days, weekly_target: target } = habit.schedule;
  return scheduleWords(kind, days, target);
}

function Row({
  habit,
  onOpen,
  reorder,
}: {
  habit: Habit;
  onOpen: () => void;
  reorder: { onMove: (delta: number) => void; first: boolean; last: boolean } | null;
}) {
  const paused = habit.schedule?.schedule_kind === "paused";

  return (
    <li className="border-line/70 flex items-center gap-1 border-b last:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        // In reorder mode the row is still the way into the editor, but the
        // arrows are what the thumb is aiming at, so it stops inviting taps.
        className={`active:bg-raised -mx-2 flex min-h-14 flex-1 items-center gap-3 rounded-lg px-2 text-left transition-colors ${
          reorder ? "" : "hover:bg-raised/60"
        }`}
      >
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{
            background: `var(--c-${habit.color_token})`,
            // A paused habit is still itself, just not being asked of — the
            // colour hollows out rather than changing.
            opacity: paused ? 0.35 : 1,
          }}
        />
        <span className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-4">
          <span className="text-row block truncate font-medium sm:flex-1">{habit.name}</span>
          <span className="text-meta text-muted block sm:shrink-0">{summary(habit)}</span>
        </span>
        {!reorder && <Chevron className="text-muted shrink-0" />}
      </button>

      {reorder && (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={`Move ${habit.name} up`}
            disabled={reorder.first}
            onClick={() => reorder.onMove(-1)}
            className={ICON_BUTTON}
          >
            <Chevron className="-rotate-90" />
          </button>
          <button
            type="button"
            aria-label={`Move ${habit.name} down`}
            disabled={reorder.last}
            onClick={() => reorder.onMove(1)}
            className={ICON_BUTTON}
          >
            <Chevron className="rotate-90" />
          </button>
        </span>
      )}
    </li>
  );
}

// --- settings ---------------------------------------------------------------

/**
 * The two things that are not habits: how it looks, and getting the data out.
 *
 * The export is a plain link. The endpoint already sends Content-Disposition
 * with a dated filename and the session cookie rides along on a same-origin
 * navigation, so fetching it into a blob would be more code for a worse result
 * — no progress, no native "keep" dialog on a phone.
 */
function Settings() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  const choose = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
  };

  return (
    <section aria-labelledby="settings-heading" className="border-line mt-14 border-t pt-6">
      <h2 id="settings-heading" className="text-section pb-3 font-semibold tracking-[-0.01em]">
        Settings
      </h2>

      <div className="grid gap-6 sm:max-w-sm">
        <fieldset>
          <legend className="text-meta text-muted pb-1.5">Appearance</legend>
          <div className="grid grid-cols-2 gap-2">
            <Choice
              type="radio"
              name="theme"
              checked={theme === "dark"}
              onChange={() => choose("dark")}
              label="Dark theme"
            >
              Dark
            </Choice>
            <Choice
              type="radio"
              name="theme"
              checked={theme === "light"}
              onChange={() => choose("light")}
              label="Light theme"
            >
              Light
            </Choice>
          </div>
        </fieldset>

        <div>
          <h3 className="text-meta text-muted pb-1.5">Your data</h3>
          <a
            href="/api/export"
            download
            className="border-line-strong hover:bg-raised grid min-h-12 place-items-center rounded-lg border px-4 font-medium"
          >
            Download everything
          </a>
          <p className="text-meta text-muted mt-2">
            One JSON file with every habit, schedule, log, task and note — archived ones included.
            Months of history are only worth keeping if you can take them with you.
          </p>
        </div>
      </div>
    </section>
  );
}

// --- the screen -------------------------------------------------------------

const HabitsSkeleton = () => (
  <div className="grid gap-3 pt-2">
    {[0, 1, 2, 3].map((row) => (
      <Skeleton key={row} className="h-14" />
    ))}
  </div>
);

export default function Habits() {
  // Archived habits are asked for up front and split out below: they are the
  // only way back to a habit you put away, and a second request for a list this
  // small would buy nothing.
  const query = useHabits(true);
  const reorder = useReorderHabits(true);

  const [newHabit, setNewHabit] = useState(false);
  const [editing, setEditing] = useState<Id | null>(null);
  const [reordering, setReordering] = useState(false);

  const habits = query.data ?? [];
  const active = habits.filter((habit) => habit.archived_on === null);
  const archived = habits.filter((habit) => habit.archived_on !== null);

  const open = habits.find((habit) => habit.id === editing) ?? null;

  /**
   * The server rejects an order that is not every active habit exactly once, so
   * the whole active list goes with every move. splice rather than index
   * juggling — one statement, and nothing to get backwards.
   */
  const move = (id: Id, delta: number) => {
    const ids = active.map((habit) => habit.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    reorder.mutate(ids);
  };

  return (
    <div className="mx-auto w-full max-w-[68rem] px-4 pb-20 sm:px-6 lg:px-8">
      <header className="pt-5 pb-7 sm:pt-8 lg:max-w-[46rem]">
        <div className="flex items-center justify-between gap-3">
          <p className="text-meta text-muted">
            {active.length === 0
              ? "Nothing tracked yet"
              : active.length === 1
                ? "One habit"
                : `${active.length} habits`}
          </p>

          <div className="flex shrink-0 items-center gap-1.5">
            {active.length > 1 && (
              <button
                type="button"
                onClick={() => setReordering(!reordering)}
                className="border-line-strong hover:bg-raised text-meta min-h-11 rounded-lg border px-3 font-medium"
              >
                {reordering ? "Done" : "Reorder"}
              </button>
            )}
            <button
              type="button"
              onClick={() => setNewHabit(true)}
              className="bg-ink text-canvas text-meta min-h-11 rounded-lg px-3 font-semibold"
            >
              New habit
            </button>
          </div>
        </div>

        <h1 className="font-serif text-date mt-1 tracking-[-0.015em]">Habits</h1>
      </header>

      {query.isError && !query.data ? (
        <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <HabitsSkeleton />
      ) : (
        <main className="lg:max-w-[46rem]">
          {/* A failed move has already rolled back on screen, so the only thing
              left to do is say why the list snapped back. */}
          {reorder.isError && (
            <p role="alert" className="text-warn text-meta pb-2">
              {reorder.error.message}
            </p>
          )}

          {active.length === 0 ? (
            <section>
              <p className="text-row">Nothing tracked yet.</p>
              <p className="text-muted mt-1 max-w-sm">
                Start with one habit you actually want to keep. You can add more once it sticks.
              </p>
              <button
                type="button"
                onClick={() => setNewHabit(true)}
                className="bg-ink text-canvas mt-5 min-h-12 rounded-lg px-5 font-semibold"
              >
                Add the first habit
              </button>
            </section>
          ) : (
            <ul>
              {active.map((habit, index) => (
                <Row
                  key={habit.id}
                  habit={habit}
                  onOpen={() => setEditing(habit.id)}
                  reorder={
                    reordering
                      ? {
                          onMove: (delta: number) => move(habit.id, delta),
                          first: index === 0,
                          last: index === active.length - 1,
                        }
                      : null
                  }
                />
              ))}
            </ul>
          )}

          {archived.length > 0 && (
            <details className="group border-line mt-6 border-t pt-1">
              <summary className="text-meta text-muted hover:text-ink flex min-h-11 cursor-pointer list-none items-center gap-1.5">
                <Chevron className="transition-transform group-open:rotate-90" />
                {archived.length === 1 ? "One archived habit" : `${archived.length} archived`}
              </summary>
              <ul className="opacity-70">
                {archived.map((habit) => (
                  <Row
                    key={habit.id}
                    habit={habit}
                    onOpen={() => setEditing(habit.id)}
                    reorder={null}
                  />
                ))}
              </ul>
            </details>
          )}

          <Settings />
        </main>
      )}

      <NewHabitDialog open={newHabit} onClose={() => setNewHabit(false)} />
      {open && <HabitEditor habit={open} onClose={() => setEditing(null)} />}
    </div>
  );
}
