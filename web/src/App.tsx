import { Link, Navigate, Route, Routes, useLocation } from "react-router";

import { useLogout, useSession } from "./features/auth/queries";
import Day from "./routes/Day";
import Grid from "./routes/Grid";
import Habits from "./routes/Habits";
import Login from "./routes/Login";
import Review from "./routes/Review";
import Tasks from "./routes/Tasks";

/**
 * The session query is the only route guard. It sits behind requireAuth on the
 * server, so an error — 401, expired, tampered — means "not signed in", and
 * main.tsx marks it stale whenever any other request 401s.
 */
export default function App() {
  const session = useSession();

  if (session.isPending) return <Boot />;
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
 * Five words plus "Sign out" is close to the width of a small phone, so the row
 * scrolls rather than wraps or squeezes — at any width that fits, nothing moves
 * and there is nothing to see.
 */
function Tabs() {
  const { pathname } = useLocation();
  const logout = useLogout();
  const onGrid = pathname.startsWith("/grid");
  const onReview = pathname.startsWith("/review");
  const onHabits = pathname.startsWith("/habits");
  const onTasks = pathname.startsWith("/tasks");

  return (
    // pt-[env(...)] is zero in a browser tab and the status bar's height in an
    // installed app, where viewport-fit=cover lets the page reach under it.
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
        <button
          type="button"
          onClick={() => logout.mutate()}
          className="text-meta text-muted hover:text-ink ml-auto min-h-11 shrink-0 px-2 transition-colors"
        >
          Sign out
        </button>
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
