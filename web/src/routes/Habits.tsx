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
 * Settings live at the bottom rather than behind a tab of their own: there are
 * three of them, and the one thing a person will look for after "where are my
 * habits" is "where is my data". Signing out is the third, moved off the tab
 * row where it cost a seventh of a small phone's width.
 */
import { useState } from "react";
import { Link } from "react-router";

import { ErrorBox } from "../components/ErrorBox";
import { Choice } from "../components/Choice";
import { ICON_BUTTON, PRIMARY, QUIET } from "../components/form";
import { Chevron } from "../components/icons";
import { Skeleton } from "../components/Skeleton";
import { useLogout } from "../features/auth/queries";
import { Backup } from "../features/backup/Backup";
import { Notifications } from "../features/notifications/Notifications";
import { NewHabitDialog } from "../features/habits/NewHabitDialog";
import { useHabits, useReorderHabits } from "../features/habits/queries";
import { scheduleWords } from "../features/habits/verdict";
import { formatDateShort } from "../lib/dates";
import { applyTheme, readTheme, type Theme } from "../lib/theme";
import type { Habit, Id } from "../types";

/**
 * The one line under a habit's name: what is being asked of it.
 *
 * A habit whose start date has not arrived resolves to no schedule at all — the
 * server reports `schedule: null` rather than the version waiting behind it —
 * so that case says when it begins instead of saying nothing.
 */
function summary(habit: Habit): string {
  if (!habit.schedule) return `Starts ${formatDateShort(habit.start_date)}`;
  const {
    schedule_kind: kind,
    schedule_days: days,
    weekly_target: target,
    target_value: amount,
  } = habit.schedule;
  const now = scheduleWords(kind, days, target, amount, habit.unit);

  // A change that has been decided but has not started — a switch between
  // certain days and times a week waits for the following Monday. Said here as
  // well as in the editor so it is not something you have to go looking for,
  // and always after the current one, which is what the row is about.
  const next = habit.next_schedule;
  if (!next) return now;

  const words = scheduleWords(
    next.schedule_kind,
    next.schedule_days,
    next.weekly_target,
    next.target_value,
    habit.unit,
  );
  return `${now} · then ${words} from ${formatDateShort(next.effective_from)}`;
}

function Row({
  habit,
  reorder,
}: {
  habit: Habit;
  reorder: { onMove: (delta: number) => void; first: boolean; last: boolean } | null;
}) {
  const paused = habit.schedule?.schedule_kind === "paused";

  return (
    <li className="border-grid/70 flex items-center gap-1 border-b last:border-b-0">
      {/*
       * Into the habit's own history, not straight into the editor. The chevron
       * then means what a chevron means — there is more of this underneath —
       * and editing is reached from the one screen that shows you what you would
       * be editing. It is also the only route to an archived habit's record.
       *
       * In reorder mode the row is still the way in, but the arrows are what the
       * thumb is aiming at, so it stops inviting taps.
       */}
      <Link
        to={`/habits/${habit.id}`}
        className={`active:bg-raised -mx-2 flex min-h-14 flex-1 items-center gap-3 px-2 text-left transition-colors ${
          reorder ? "" : "hover:bg-raised/60"
        }`}
      >
        <span
          aria-hidden="true"
          className="h-5 w-[3px] shrink-0"
          style={{
            background: `var(--c-${habit.color_token})`,
            // A paused habit is still itself, just not being asked of — the
            // colour hollows out rather than changing.
            opacity: paused ? 0.35 : 1,
          }}
        />
        <span className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-4">
          <span className="text-name block truncate font-serif sm:flex-1">{habit.name}</span>
          <span className="label text-muted block sm:shrink-0">{summary(habit)}</span>
        </span>
        {!reorder && <Chevron className="text-muted shrink-0" />}
      </Link>

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
 * The things that are not habits: how it looks, when it reminds you, getting
 * the data out — and getting it back in, which is the half that makes the other
 * half worth anything. Both live in features/backup.
 */
function Settings() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const logout = useLogout();

  const choose = (next: Theme) => {
    applyTheme(next);
    setTheme(next);
  };

  return (
    <section
      aria-labelledby="settings-heading"
      className="border-grid border-t pt-6 md:border-t-0 md:pt-0"
    >
      <h2 id="settings-heading" className="label text-ink border-baseline mb-3 border-b pb-2">
        Settings
      </h2>

      <div className="grid gap-6 sm:max-w-sm">
        <fieldset>
          <legend className="label text-muted pb-2.5">Appearance</legend>
          <div className="flex max-w-[16rem]">
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

        {/* Between how it looks and where the data goes: a reminder is a
            preference about this device and this app, not a habit. */}
        <Notifications />

        <Backup />

        {/* Moved here off the tab row, where it spent a seventh of a small
            phone's width on the rarest thing in the app and pushed the five
            screens into a scroller. Nothing is confirmed: the session is a
            cookie and signing back in is one field. */}
        <div>
          <h3 className="label text-muted pb-2.5">Session</h3>
          <button
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className={QUIET}
          >
            {logout.isPending ? "Signing out…" : "Sign out"}
          </button>
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
  const [reordering, setReordering] = useState(false);

  const habits = query.data ?? [];
  const active = habits.filter((habit) => habit.archived_on === null);
  const archived = habits.filter((habit) => habit.archived_on !== null);

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
      <header className="pt-5 pb-7 sm:pt-8">
        <div className="flex items-center justify-between gap-3">
          <p className="label text-muted">
            {active.length === 0
              ? "Nothing tracked yet"
              : active.length === 1
                ? "One habit"
                : `${active.length} habits`}
          </p>

          <div className="flex shrink-0 items-center gap-1.5">
            {active.length > 1 && (
              <button type="button" onClick={() => setReordering(!reordering)} className={QUIET}>
                {reordering ? "Done" : "Reorder"}
              </button>
            )}
            <button type="button" onClick={() => setNewHabit(true)} className={`${PRIMARY} w-auto`}>
              New habit
            </button>
          </div>
        </div>

        <h1 className="font-serif text-title mt-2 tracking-[-0.02em]">Habits</h1>
      </header>

      {query.isError && !query.data ? (
        <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <HabitsSkeleton />
      ) : (
        <main className="md:grid md:grid-cols-[minmax(0,1fr)_17rem] md:items-start md:gap-x-8 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-x-12 xl:gap-x-16">
          <div className="md:col-start-1 md:row-start-1">
            {/* A failed move has already rolled back on screen, so the only thing
              left to do is say why the list snapped back. */}
            {reorder.isError && (
              <p role="alert" className="text-warn text-meta pb-2">
                {reorder.error.message}
              </p>
            )}

            {active.length === 0 ? (
              <section>
                <p className="text-name font-serif">Nothing tracked yet.</p>
                <p className="text-muted mt-1 max-w-sm">
                  Start with one habit you actually want to keep. You can add more once it sticks.
                </p>
                <button
                  type="button"
                  onClick={() => setNewHabit(true)}
                  className={`${PRIMARY} mt-6 w-auto`}
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
              <details className="group border-grid mt-6 border-t pt-1">
                <summary className="label text-muted hover:text-ink flex min-h-11 cursor-pointer list-none items-center gap-1.5">
                  <Chevron className="transition-transform group-open:rotate-90" />
                  {archived.length === 1 ? "One archived habit" : `${archived.length} archived`}
                </summary>
                <ul className="opacity-70">
                  {archived.map((habit) => (
                    <Row key={habit.id} habit={habit} reorder={null} />
                  ))}
                </ul>
              </details>
            )}
          </div>

          <div className="mt-14 md:col-start-2 md:row-start-1 md:mt-0">
            <Settings />
          </div>
        </main>
      )}

      <NewHabitDialog
        open={newHabit}
        onClose={() => setNewHabit(false)}
        taken={active.map((habit) => habit.color_token)}
      />
    </div>
  );
}
