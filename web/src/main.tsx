// Three voices, three faces. The mono is the instrument's register and carries
// every number in the app, which is why it is worth its own family rather than
// tabular figures in the sans: a readout that is not monospaced is not a readout.
// Latin subsets only, and only the weights actually used.
import "@fontsource-variable/instrument-sans/wght.css";
import "@fontsource/newsreader/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "./index.css";

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { ApiError } from "./lib/api-client";
import { applyTheme, readTheme } from "./lib/theme";
import App from "./App";

const is401 = (error: unknown) => error instanceof ApiError && error.status === 401;

/**
 * One place handles an expired or missing session: any 401 marks the session
 * query stale, it refetches, fails, and App renders the login form. That is the
 * whole of route guarding and the whole of session expiry — no AuthContext, no
 * <ProtectedRoute>, no countdown.
 *
 * The session query's own 401 is skipped, or invalidating it would refetch it,
 * 401 again, and loop.
 */
const client: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (is401(error) && query.queryKey[0] !== "session") {
        void client.invalidateQueries({ queryKey: ["session"] });
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (is401(error)) void client.invalidateQueries({ queryKey: ["session"] });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // A phone coming back from the background may have crossed midnight.
      refetchOnWindowFocus: true,
      retry: (count, error) =>
        !(error instanceof ApiError && (error.status === 401 || error.status === 0)) && count < 1,
    },
  },
});

// Before the first render, so a remembered light theme does not flash dark.
// It cannot go any earlier: Helmet's CSP is script-src 'self', so index.html
// carries no inline script and ships the dark default instead.
applyTheme(readTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
