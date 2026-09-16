/**
 * THE DESK — a personal LeetCode workspace.
 *
 * The one screen in this product that is laptop-first, and it says so
 * structurally rather than apologising for it: an index of everything solved
 * down the left, and the problem itself — statement, approach, code — filling
 * the rest. You solve on a laptop, you screenshot on a laptop, and you come
 * back months later on a laptop.
 *
 * It borrows the instrument's SUBSTRATE and refuses its METAPHOR. The voices
 * are the same three (mono for every number, small caps for anything the
 * machine says about itself, serif for names and for everything you wrote),
 * there is one surface and no cards, and the writing field is the same ruled
 * paper the journal uses — which was always a notebook effect and was waiting
 * for a notebook. But there is no time axis of problems, no channel per topic,
 * no verdict marks and no consistency rate, because a chart recorder drawn over
 * a study log produces exactly the scoreboard this feature must not be.
 *
 * NOTHING HERE IS SCORED. No count of problems solved as an achievement, no
 * rate, no best week, no streak of days practised. The one number on the screen
 * is the size of the review queue, and that is a workload rather than a
 * score — a thing to be emptied, not a thing to be maximised.
 *
 * "Needs review" is derived on every render from `ai_assisted && !reviewed_on`
 * and is never stored, never fetched as its own scope, and never counted
 * anywhere but here. See needsReview() in features/leetcode/problems.ts.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";

import { Choice } from "../components/Choice";
import { ErrorBox } from "../components/ErrorBox";
import { FIELD, PRIMARY, QUIET } from "../components/form";
import { Chevron } from "../components/icons";
import { Skeleton } from "../components/Skeleton";
import { ProblemDetail } from "../features/leetcode/ProblemDetail";
import { ProblemEditor } from "../features/leetcode/ProblemEditor";
import { DIFFICULTIES, matches, needsReview, topicVocabulary } from "../features/leetcode/problems";
import { useProblems } from "../features/leetcode/queries";
import { formatDateShort } from "../lib/dates";
import type { Difficulty, Id, Problem } from "../types";

/**
 * Three views of the same rows, and only one of them is a server scope.
 *
 * "Needs review" is a filter over the active list rather than a request of its
 * own, deliberately: the queue is derived from two columns the list already
 * carries, and a second read of the same rows is a second answer that can
 * disagree with the first.
 */
type View = "active" | "review" | "archived";

function Row({ problem, selected }: { problem: Problem; selected: boolean }) {
  const waiting = needsReview(problem);

  return (
    <li
      className={
        // A rule down the edge for anything still waiting, which is the state
        // the whole feature exists to make visible. It is a shape as well as a
        // hue — the word beside it carries the same claim — so it survives
        // greyscale and it survives not being able to see the red.
        `border-l-2 ${waiting ? "border-warn" : "border-transparent"}`
      }
    >
      <Link
        to={`/leetcode/${problem.id}`}
        aria-current={selected ? "page" : undefined}
        className={`hover:bg-raised block py-2.5 pr-2 pl-2.5 transition-colors ${
          selected ? "bg-raised" : ""
        }`}
      >
        <span className="flex items-baseline gap-2.5">
          <span className="text-muted text-meta w-9 shrink-0 text-right font-mono">
            {problem.number ?? ""}
          </span>
          <span className="text-ui min-w-0 flex-1 truncate font-serif">{problem.title}</span>
          <span className="label text-muted shrink-0">{problem.difficulty}</span>
        </span>

        <span className="mt-0.5 flex items-baseline gap-2.5 pl-[3.125rem]">
          <span className="label text-muted min-w-0 flex-1 truncate">
            {problem.topics.join(" · ")}
          </span>
          {waiting ? (
            <span className="label text-warn shrink-0">Review</span>
          ) : problem.ai_assisted ? (
            <span className="label text-muted shrink-0">AI</span>
          ) : null}
          <span className="text-muted text-tick shrink-0 font-mono">
            {formatDateShort(problem.solved_on)}
          </span>
        </span>
      </Link>
    </li>
  );
}

const IndexSkeleton = () => (
  <div className="grid gap-2 pt-2">
    {[0, 1, 2, 3, 4, 5].map((row) => (
      <Skeleton key={row} className="h-12" />
    ))}
  </div>
);

/**
 * What fills the right-hand side when nothing is open.
 *
 * The queue, rather than a blank pane or a picture: it is the reason the
 * feature exists, and a workspace that opens on it is a workspace that gets the
 * reviewing done. An empty queue says so in one line and stops.
 */
function Queue({ problems }: { problems: Problem[] }) {
  const waiting = problems.filter(needsReview);

  return (
    <div className="max-w-xl">
      <p className="label text-muted">Needs review</p>
      {/* h2, not h1. The index carries this screen's one h1 whichever pane is
          showing, and on a wide screen both panes are on the page at once. */}
      <h2 className="font-serif text-title mt-2 tracking-[-0.02em]">
        {waiting.length === 0 ? "Nothing waiting" : "Back over these"}
      </h2>

      {waiting.length === 0 ? (
        <p className="text-muted mt-4">
          Everything you had help with, you have been back to. Mark a problem AI-assisted when you
          record it and it will wait here until you have.
        </p>
      ) : (
        <>
          <p className="text-muted mt-4">
            You had significant help on these and have not been back to them yet. There is no clock
            on it.
          </p>
          {/* Named, because on a wide screen this list and the index beside
              it hold some of the same rows, and "which list am I in" has to be
              answerable without seeing the layout. */}
          <ul aria-label="Problems needing review" className="mt-6">
            {waiting.map((problem) => (
              <li key={problem.id} className="border-grid border-b last:border-b-0">
                <Link
                  to={`/leetcode/${problem.id}`}
                  className="hover:bg-raised flex items-baseline gap-3 py-3 pr-2 pl-1 transition-colors"
                >
                  <span className="text-muted text-meta w-9 shrink-0 text-right font-mono">
                    {problem.number ?? ""}
                  </span>
                  <span className="text-ui min-w-0 flex-1 truncate font-serif">
                    {problem.title}
                  </span>
                  <span className="label text-muted shrink-0">{problem.difficulty}</span>
                  <Chevron className="text-muted shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default function Leetcode() {
  const { id = null } = useParams();
  const navigate = useNavigate();

  const [view, setView] = useState<View>("active");
  const [search, setSearch] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty | "">("");
  const [recording, setRecording] = useState(false);

  const active = useProblems("active");
  // Its own read rather than a filter of the one above: "archived" is a
  // different view of the table, not a subset — the active list deliberately
  // excludes archived rows entirely.
  const archived = useProblems("archived");

  const query = view === "archived" ? archived : active;
  const rows = useMemo(() => query.data?.problems ?? [], [query.data]);
  const activeRows = useMemo(() => active.data?.problems ?? [], [active.data]);

  /*
   * The server's today, in APP_TIMEZONE. It dates a new entry, and the browser
   * must not: a problem solved at half past eleven on a laptop an hour ahead of
   * the app's zone would file itself under tomorrow. Empty until the payload
   * lands, at which point there is nothing on screen to date anyway.
   */
  const today = active.data?.today ?? "";

  const waiting = activeRows.filter(needsReview).length;
  const vocabulary = useMemo(() => topicVocabulary(activeRows), [activeRows]);

  const shown = useMemo(
    () =>
      rows
        .filter((problem) => view !== "review" || needsReview(problem))
        .filter((problem) => difficulty === "" || problem.difficulty === difficulty)
        .filter((problem) => matches(problem, search)),
    [rows, view, difficulty, search],
  );

  /** Clicking a tag is the topic filter — through the field that already exists. */
  const searchTopic = (topic: string) => {
    setView("active");
    setDifficulty("");
    setSearch(topic);
  };

  return (
    <div className="mx-auto w-full max-w-[110rem] px-4 pb-20 sm:px-6 lg:px-8">
      <div className="lg:grid lg:grid-cols-[21rem_minmax(0,1fr)] lg:items-start lg:gap-x-10 xl:grid-cols-[23rem_minmax(0,1fr)] xl:gap-x-16">
        {/* THE INDEX. Scrolls on its own on a wide screen so the statement
            stays put while you look down the list for something. */}
        <div className="lg:sticky lg:top-0 lg:max-h-dvh lg:overflow-y-auto lg:pb-8">
          <header className="pt-5 pb-5 sm:pt-8">
            <p className="label text-muted">
              {/* Nothing rather than a guess until the payload lands: an empty
                  list and an unanswered one are different things. */}
              {!active.data
                ? ""
                : `${activeRows.length} recorded${waiting > 0 ? ` · ${waiting} needing review` : ""}`}
            </p>
            <h1 className="font-serif text-title mt-2 tracking-[-0.02em]">Code</h1>
          </header>

          {/* On a phone the URL decides which pane is the screen, so the list
              and its controls stand down when a problem is open. The heading
              above stays, which is what keeps one h1 on the page either way. */}
          <div className={id === null ? "" : "hidden lg:block"}>
            {/* Sized to its label. PRIMARY is a full-width key — right at the
                foot of a dialog, wrong as a solid slab across a whole column
                whose subject is the list under it.
                The wrapper is what does it, not a w-auto on the button: that
                and PRIMARY's own w-full are the same utility, so which one wins
                is decided by the order Tailwind emits them in rather than by
                the order they are written in, and w-full wins. An inline-flex
                box is sized by its content, and the button's 100% then resolves
                against that. The key on /habits gets away with w-auto only
                because it is a flex item with a sibling to shrink against. */}
            <span className="inline-flex">
              <button
                type="button"
                className={`${PRIMARY} px-5`}
                onClick={() => setRecording(true)}
              >
                Record a problem
              </button>
            </span>

            <div className="mt-6 flex">
              {/* The accessible name stays put while the visible label counts.
                  A name that changed as the queue emptied would rename the
                  control under anyone navigating by it, and the number is
                  already in the eyebrow above for a reader who wants it. */}
              {(
                [
                  ["active", "All problems", "All"],
                  ["review", "Needs review", waiting > 0 ? `Review ${waiting}` : "Review"],
                  ["archived", "Archived", "Archived"],
                ] as const
              ).map(([value, name, visible]) => (
                <Choice
                  key={value}
                  type="radio"
                  name="leetcode-view"
                  checked={view === value}
                  onChange={() => setView(value)}
                  label={name}
                >
                  {visible}
                </Choice>
              ))}
            </div>

            <div className="mt-5 flex items-end gap-3">
              <div className="min-w-0 flex-1">
                <label htmlFor="leetcode-search" className="label text-muted block pb-1.5">
                  Find
                </label>
                <input
                  id="leetcode-search"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Number, title or topic"
                  className={FIELD}
                />
              </div>
              <div className="w-28 shrink-0">
                <label htmlFor="leetcode-difficulty" className="label text-muted block pb-1.5">
                  Level
                </label>
                <select
                  id="leetcode-difficulty"
                  value={difficulty}
                  onChange={(event) => setDifficulty(event.target.value as Difficulty | "")}
                  className={FIELD}
                >
                  <option value="">Any</option>
                  {DIFFICULTIES.map((level) => (
                    <option key={level} value={level}>
                      {level}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-6">
              {query.isError && !query.data ? (
                <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
              ) : !query.data ? (
                <IndexSkeleton />
              ) : shown.length === 0 ? (
                <p className="text-muted text-meta py-4">
                  {rows.length === 0
                    ? view === "archived"
                      ? "Nothing archived."
                      : view === "review"
                        ? "Nothing waiting to be reviewed."
                        : "Nothing recorded yet. Solve something and write it down."
                    : "Nothing matches that."}
                </p>
              ) : (
                <ul aria-label="Recorded problems" className="-ml-0.5">
                  {shown.map((problem) => (
                    <Row key={problem.id} problem={problem} selected={problem.id === id} />
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* The way back on a phone, where the index is not on screen. */}
          {id !== null && (
            <Link to="/leetcode" className={`${QUIET} mt-2 lg:hidden`}>
              All problems
            </Link>
          )}
        </div>

        {/* THE PROBLEM. */}
        <div className={`pt-5 sm:pt-8 ${id === null ? "hidden lg:block" : ""}`}>
          {id === null ? (
            !active.data ? (
              <IndexSkeleton />
            ) : (
              <Queue problems={activeRows} />
            )
          ) : (
            <ProblemDetail
              // Remounted per problem so every piece of local state in it —
              // the two note fields especially — starts from that problem's
              // text rather than carrying the last one's over.
              key={id}
              id={id as Id}
              today={today}
              vocabulary={vocabulary}
              siblings={activeRows}
              onTopic={searchTopic}
            />
          )}
        </div>
      </div>

      {recording && (
        <ProblemEditor
          problem={null}
          today={today}
          vocabulary={vocabulary}
          siblings={activeRows}
          onClose={() => setRecording(false)}
          onCreated={(problem) => {
            setRecording(false);
            navigate(`/leetcode/${problem.id}`);
          }}
        />
      )}
    </div>
  );
}
