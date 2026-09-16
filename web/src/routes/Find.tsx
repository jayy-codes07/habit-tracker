/**
 * Find — one box over everything that was ever written down.
 *
 * The product's whole claim is that it records what happened. This is the other
 * half of that claim: a record you cannot get back into is a record you do not
 * have. Day entries, habit notes, monthly reflections and the LeetCode
 * workspace's three text fields are all one list here, ordered by date and
 * interleaved — because "when did I write about the knee" is a question about a
 * time and not about which screen the sentence happened to be typed on.
 *
 * What it is not, and must not become: this is a way back to a thing, not a
 * reading of the record. There is no count of how much has been written, no
 * breakdown by source, no "you wrote most in March". The one figure on the
 * screen is how many results came back, which is a fact about the search.
 *
 * Every row states its source in words. A search result that does not say what
 * it is makes the reader open it to find out, and four kinds that all look like
 * a date and a sentence is exactly the pile this is meant to replace.
 */
import { useDeferredValue, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";

import { ErrorBox } from "../components/ErrorBox";
import { FIELD } from "../components/form";
import { Chevron } from "../components/icons";
import { Skeleton } from "../components/Skeleton";
import { useSearch, MIN_QUERY } from "../features/search/queries";
import { hrefOf, KIND_LABEL, splitMatch } from "../features/search/results";
import { formatDateShort, formatMonthLong, monthOf } from "../lib/dates";
import type { SearchResult } from "../types";

/**
 * A reflection belongs to its month, not to the 1st — which is only where it is
 * anchored. Dating one "1 Mar 2026" in a list would invite the reader to open
 * the wrong screen looking for it.
 */
const dateOf = (result: SearchResult) =>
  result.kind === "reflection"
    ? formatMonthLong(monthOf(result.date))
    : formatDateShort(result.date);

/**
 * The snippet, with the matched text marked.
 *
 * Marked by splitting rather than by inserting markup: this is the user's own
 * prose coming back from the database, and the one thing that must never happen
 * to it on the way to the screen is dangerouslySetInnerHTML.
 */
function Snippet({ text, query }: { text: string; query: string }) {
  return (
    <p className="text-read mt-1 font-serif">
      {splitMatch(text, query).map((piece, index) =>
        // Every odd piece is a match — see splitMatch. The index is a safe key
        // here and nowhere else: the array is rebuilt whole on every render and
        // nothing in it is stateful or reorderable.
        index % 2 === 1 ? (
          <mark key={index} className="bg-tray text-ink">
            {piece}
          </mark>
        ) : (
          piece
        ),
      )}
    </p>
  );
}

function Row({ result, query }: { result: SearchResult; query: string }) {
  return (
    <li className="relative py-3 pl-5">
      {/* The same rail the habit history's stream uses, and for the same
          reason: a list of things that happened, indexed down one line. */}
      <span aria-hidden="true" className="bg-baseline absolute top-[1.35rem] -left-px h-px w-2.5" />

      <Link
        to={hrefOf(result)}
        className="hover:text-ink text-muted font-mono text-meta inline-flex min-h-7 items-center gap-1.5"
      >
        {dateOf(result)} · {KIND_LABEL[result.kind]}
        {/* Archived is a fact about the row, not a warning. A solve that was
            put away still happened, and the result still opens. */}
        {result.archived && " · archived"}
        <Chevron />
      </Link>

      {result.title && <p className="font-serif text-name mt-0.5">{result.title}</p>}
      {result.snippet && <Snippet text={result.snippet} query={query} />}
    </li>
  );
}

const FindSkeleton = () => (
  <div className="grid gap-4 pt-2">
    {[0, 1, 2].map((row) => (
      <Skeleton key={row} className="h-14" />
    ))}
  </div>
);

export default function Find() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(() => params.get("q") ?? "");

  /*
   * The typed value drives the box and a deferred copy drives the request, so
   * the field never waits on the network and no debounce timer has to be owned,
   * cleared or got wrong. React 19 does this already; a useEffect and a
   * setTimeout would be a worse copy of it.
   */
  const query = useDeferredValue(text.trim());
  const search = useSearch(query);

  /*
   * The URL carries the query so a result can be shared, reloaded and — the one
   * that matters — come back to with the browser's own Back button after
   * opening a result. `replace`, so typing does not fill the history with one
   * entry per keystroke.
   */
  useEffect(() => {
    if ((params.get("q") ?? "") !== query) {
      setParams(query ? { q: query } : {}, { replace: true });
    }
    // The query is the only thing that may drive this; including the params
    // object would re-run it on every navigation that touches the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const results = search.data?.results ?? [];
  const asked = query.length >= MIN_QUERY;

  return (
    <div className="mx-auto w-full max-w-[84rem] px-4 pb-16 sm:px-6 lg:px-8">
      <header className="max-w-[46rem] pt-6 pb-7 sm:pt-10">
        <p className="label text-muted">Find · everything written down</p>
        <h1 className="font-serif text-title mt-2 tracking-[-0.015em]">Find</h1>

        {/* A form, so Enter on a phone closes the keyboard instead of doing
            nothing. The results are already live; submitting only blurs. */}
        <form
          className="mt-6"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          <label htmlFor="find-query" className="label text-muted">
            Search
          </label>
          <input
            id="find-query"
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="A word you remember writing"
            autoComplete="off"
            // The one field in the app worth opening focused: there is nothing
            // else on this screen to do.
            autoFocus
            className={`${FIELD} mt-1`}
          />
        </form>

        <p className="label text-muted mt-3 min-h-[0.875rem]">
          {!asked
            ? "Day entries, habit notes, monthly reflections, and problems — titles, approaches, solutions and topics."
            : search.data
              ? results.length === 0
                ? "Nothing found."
                : `${results.length} found${search.data.truncated ? " · newest first, more behind them" : ""}`
              : ""}
        </p>
      </header>

      <main className="max-w-[62ch]">
        {search.isError ? (
          <ErrorBox error={search.error} onRetry={() => void search.refetch()} />
        ) : !asked ? (
          /* Not an error and not an empty result — nothing has been asked yet,
             and the line above already says what would be searched. */
          <p className="text-muted text-read font-serif">Type at least {MIN_QUERY} characters.</p>
        ) : search.isPending ? (
          <FindSkeleton />
        ) : results.length === 0 ? (
          <p className="text-muted text-read font-serif">
            Nothing in the record matches “{query}”.
          </p>
        ) : (
          <ul
            className={`border-grid border-l transition-opacity ${
              search.isPlaceholderData ? "opacity-50" : "opacity-100"
            }`}
          >
            {results.map((result) => (
              <Row
                key={`${result.kind}-${result.id ?? ""}-${result.date}`}
                result={result}
                query={query}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
