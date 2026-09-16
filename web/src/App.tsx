import { Link, Navigate, Route, Routes, useLocation } from "react-router";

import { ErrorBox } from "./components/ErrorBox";
import { useSession } from "./features/auth/queries";
import { ApiError } from "./lib/api-client";
import Day from "./routes/Day";
import Grid from "./routes/Grid";
import HabitHistory from "./routes/HabitHistory";
import Habits from "./routes/Habits";
import Login from "./routes/Login";
import Review from "./routes/Review";
import Tasks from "./routes/Tasks";

/**
 * The session query is the only route guard. It sits behind requireAuth on the
 * server, so a REFUSED session — 401, expired, tampered — means "not signed
 * in", and main.tsx marks it stale whenever any other request 401s.
 *
 * A session that could not be asked about is a different thing, and the two
 * must not share a screen. request() reports an unreachable server as status 0,
 * and showing Login for that tells someone holding a phone with no signal that
 * they have been signed out — they have not, and their password cannot fix it.
 * So a transport failure says so and offers a retry, and only a real refusal
 * reaches Login.
 */
export default function App() {
  const session = useSession();
  const unreachable = session.error instanceof ApiError && session.error.status === 0;

  if (session.isPending) return <Boot />;
  if (unreachable)
    return <Unreachable error={session.error} onRetry={() => void session.refetch()} />;
  if (session.isError) return <Login />;

  return (
    <>
      <Spine />
      {/* Offset by the rail on a wide screen, and clear of the bottom chrome on
          a phone. The safe-area inset is zero in a browser tab and the home
          indicator's height in an installed app. */}
      <div className="pb-[calc(4.5rem+env(safe-area-inset-bottom))] md:pt-0 md:pb-0 md:pl-[4.875rem]">
        <Routes>
          <Route path="/" element={<Day />} />
          <Route path="/day/:date" element={<Day />} />
          <Route path="/grid" element={<Grid />} />
          <Route path="/habits" element={<Habits />} />
          {/* One level below the list, and the only screen that is about a single
              habit over its whole life rather than about a day, a week or a
              month. Reached from the Habits list and from the sheet, which is
              where you notice a habit has gone strange. */}
          <Route path="/habits/:id" element={<HabitHistory />} />
          <Route path="/tasks" element={<Tasks />} />
          {/* Both, as /day is: the bare path opens the current month. */}
          <Route path="/review" element={<Review />} />
          <Route path="/review/:month" element={<Review />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </>
  );
}

/** Nothing for the first moment, so a fast session check never flashes. */
const Boot = () => (
  <div className="grid min-h-dvh place-items-center">
    <p className="label text-muted animate-[fade-in_200ms_400ms_both]">Loading</p>
  </div>
);

/**
 * The server could not be reached, so nothing is known about the session yet.
 * ErrorBox already carries request()'s "Can't reach the server." and a retry;
 * the session query does not retry on its own (see useSession), which is what
 * makes that button the way back rather than decoration.
 */
const Unreachable = ({ error, onRetry }: { error: unknown; onRetry: () => void }) => (
  <div className="grid min-h-dvh place-items-center p-4">
    <div className="w-full max-w-sm">
      <ErrorBox error={error} onRetry={onRetry} />
    </div>
  </div>
);

/**
 * THE SPINE — the instrument's one piece of persistent chrome, and the only
 * thing in the app that knows what the URLs are.
 *
 * Five screens, five words, and an axis. The five are positions ON that axis:
 * the active one takes ink and raises a tick out of the rule, which is the same
 * reading the range dial uses on Pattern and the same reading a scale position
 * has anywhere. It is labelled with words rather than glyphs because obvious
 * beats clever, and the instrument character comes from the tick and the rule,
 * not from hiding the names.
 *
 * It sits at the BOTTOM on a phone and on the LEFT on a wider screen. The old
 * row was a 44px bar across the top; this is 46px in thumb reach, which is two
 * pixels for the one gesture a phone-first app makes most. It also frees the
 * top edge of every screen, which is where the date now is.
 *
 * Each tab points at its bare path rather than the date or month being viewed,
 * so the tab you are already on is also the way back to now.
 *
 * Habits and Tasks sit last because you visit them to decide something rather
 * than to look at something; the three reading screens stay together. Settings
 * live at the foot of /habits — there are three of them, and a sixth position
 * for a thing you touch twice a year would cost a fifth of a small phone.
 */
const SCREENS = [
  { to: "/", label: "Day" },
  { to: "/grid", label: "Pattern" },
  { to: "/review", label: "Review" },
  { to: "/habits", label: "Habits" },
  { to: "/tasks", label: "Tasks" },
] as const;

function Spine() {
  const { pathname } = useLocation();
  const onGrid = pathname.startsWith("/grid");
  const onReview = pathname.startsWith("/review");
  const onHabits = pathname.startsWith("/habits");
  const onTasks = pathname.startsWith("/tasks");
  const active = onGrid
    ? "/grid"
    : onReview
      ? "/review"
      : onHabits
        ? "/habits"
        : onTasks
          ? "/tasks"
          : "/";

  return (
    <nav
      aria-label="Screens"
      className={
        // Phone: a bar along the bottom edge, above the home indicator. Wide:
        // a rail down the left, whose right edge IS the axis the ticks sit on.
        "border-baseline bg-canvas fixed z-30 " +
        "inset-x-0 bottom-0 border-t pb-[env(safe-area-inset-bottom)] " +
        "md:inset-y-0 md:right-auto md:left-0 md:w-[4.875rem] md:border-t-0 md:border-r md:pb-0 md:pt-[env(safe-area-inset-top)]"
      }
    >
      <div className="flex md:mt-6 md:flex-col md:items-stretch">
        {SCREENS.map((screen) => (
          <Position key={screen.to} to={screen.to} active={screen.to === active}>
            {screen.label}
          </Position>
        ))}
      </div>
    </nav>
  );
}

function Position({ to, active, children }: { to: string; active: boolean; children: string }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`label relative flex min-h-[2.875rem] flex-1 items-center justify-center transition-colors md:h-[2.625rem] md:flex-none md:justify-start md:pr-3.5 md:pl-2.5 ${
        active ? "text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {children}
      {/*
       * A tick rising OUT of the axis, not an underline floating beside it.
       * Horizontal on a phone, where the axis is the bar's top edge; vertical
       * on the rail, where the axis is its right edge.
       */}
      {active && (
        <span
          aria-hidden="true"
          className="bg-ink absolute -top-px left-1/2 h-2.5 w-0.5 -translate-x-1/2 md:top-1/2 md:left-auto md:-right-px md:h-0.5 md:w-2.5 md:translate-x-0 md:-translate-y-1/2"
        />
      )}
    </Link>
  );
}
