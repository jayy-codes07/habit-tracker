import { Link, Navigate, Route, Routes, useLocation } from "react-router";

import { useLogout, useSession } from "./features/auth/queries";
import Day from "./routes/Day";
import Grid from "./routes/Grid";
import Login from "./routes/Login";

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
 * Two screens, so two words and no chrome around them. It lives here rather
 * than in components/ because it is the only thing in the app that knows what
 * the URLs are, and that knowledge belongs next to the routes.
 *
 * "Day" points at "/" rather than the date being viewed, so the tab you are
 * already on is also the way back to today.
 */
function Tabs() {
  const { pathname } = useLocation();
  const logout = useLogout();
  const onGrid = pathname.startsWith("/grid");

  return (
    <nav className="border-line border-b">
      <div className="mx-auto flex w-full max-w-[68rem] items-center gap-1 px-4 sm:px-6 lg:px-8">
        <Tab to="/" active={!onGrid}>
          Day
        </Tab>
        <Tab to="/grid" active={onGrid}>
          Grid
        </Tab>
        <button
          type="button"
          onClick={() => logout.mutate()}
          className="text-meta text-muted hover:text-ink ml-auto min-h-11 px-2 transition-colors"
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
      className={`text-meta relative flex min-h-11 items-center px-2 font-medium transition-colors ${
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
