import { Link, Navigate, Route, Routes, useLocation } from "react-router";

import { ErrorBox } from "./components/ErrorBox";
import { useSession } from "./features/auth/queries";
import { ApiError } from "./lib/api-client";
import Day from "./routes/Day";
import Grid from "./routes/Grid";
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
      <Tabs />
      <Routes>
        <Route path="/" element={<Day />} />
        <Route path="/day/:date" element={<Day />} />
        <Route path="/grid" element={<Grid />} />
        <Route path="/habits" element={<Habits />} />
        <Route path="/tasks" element={<Tasks />} />
        {/* Both, as /day is: the bare path opens the current month. */}
        <Route path="/review" element={<Review />} />
        <Route path="/review/:month" element={<Review />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

/** Nothing for the first moment, so a fast session check never flashes. */
const Boot = () => (
  <div className="grid min-h-dvh place-items-center">
    <p className="text-muted animate-[fade-in_200ms_400ms_both]">Loading…</p>
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
 * Five screens, so five words and no chrome around them. It lives here rather
 * than in components/ because it is the only thing in the app that knows what
 * the URLs are, and that knowledge belongs next to the routes.
 *
 * Each tab points at its bare path rather than the date or month being viewed,
 * so the tab you are already on is also the way back to now.
 *
 * Habits and Tasks sit last because you visit them to decide something rather
 * than to look at something; the three reading screens stay together.
 *
 * Five words and nothing else. "Sign out" used to sit at the end of this row,
 * where it took a seventh of a 360px phone to offer the one thing you do here
 * least often, and pushed the five tabs into a scroller to do it. It lives in
 * Settings now, next to the theme and the export — the other three things that
 * are about the account rather than about a day. The row still scrolls rather
 * than wrapping if it ever has to, but at any width that fits, nothing moves.
 */
function Tabs() {
  const { pathname } = useLocation();
  const onGrid = pathname.startsWith("/grid");
  const onReview = pathname.startsWith("/review");
  const onHabits = pathname.startsWith("/habits");
  const onTasks = pathname.startsWith("/tasks");

  return (
    // The safe-area padding below is zero in a browser tab and the status bar's
    // height in an installed app, where viewport-fit=cover lets the page reach
    // under it. Spelling the utility out in prose here would be a mistake:
    // Tailwind scans this file as raw text, comments included, and would compile
    // the example into a rule that Lightning CSS then rejects.
    <nav className="border-line border-b pt-[env(safe-area-inset-top)]">
      <div className="[scrollbar-width:none] mx-auto flex w-full max-w-[68rem] items-center gap-1 overflow-x-auto px-4 sm:px-6 lg:px-8 [&::-webkit-scrollbar]:hidden">
        <Tab to="/" active={!onGrid && !onReview && !onHabits && !onTasks}>
          Day
        </Tab>
        <Tab to="/grid" active={onGrid}>
          Grid
        </Tab>
        <Tab to="/review" active={onReview}>
          Review
        </Tab>
        <Tab to="/habits" active={onHabits}>
          Habits
        </Tab>
        <Tab to="/tasks" active={onTasks}>
          Tasks
        </Tab>
      </div>
    </nav>
  );
}

function Tab({ to, active, children }: { to: string; active: boolean; children: string }) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={`text-meta relative flex min-h-11 shrink-0 items-center px-2 font-medium transition-colors ${
        active ? "text-ink" : "text-muted hover:text-ink"
      }`}
    >
      {children}
      {/* Sits on the nav's own border rather than above it, so the underline
          reads as the tab breaking through the line. */}
      {active && (
        <span
          aria-hidden="true"
          className="bg-ink absolute inset-x-2 -bottom-px h-0.5 rounded-full"
        />
      )}
    </Link>
  );
}
