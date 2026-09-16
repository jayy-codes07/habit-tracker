/**
 * ONE PROBLEM — the page you come back to months later.
 *
 * The question it answers is "what was this, and what did I understand about
 * it", so the order is the order you need it in: what the problem was (the
 * plate), then what you worked out (your words), then the code if you kept it.
 *
 * It states facts and nothing else. There is no count of problems solved, no
 * rate, no best month, no record — the same line the habit history page will
 * not cross, and for the same reason. A study log that keeps a high score turns
 * going back over an old problem into something that costs you, in a feature
 * whose entire point is going back over old problems.
 */
import { useState } from "react";

import { ProblemEditor } from "./ProblemEditor";
import { Screenshot } from "./Screenshot";
import { needsReview } from "./problems";
import { usePatchProblem, useProblem } from "./queries";
import { ErrorBox } from "../../components/ErrorBox";
import { QUIET } from "../../components/form";
import { Skeleton } from "../../components/Skeleton";
import { ApiError } from "../../lib/api-client";
import { formatDateShort } from "../../lib/dates";
import type { Id, IsoDate, Problem } from "../../types";

/**
 * A free-text field that saves when you leave it, the same way the journal
 * does. Keyed on the problem by its caller, so moving to another one starts
 * from that problem's text instead of carrying the last one over.
 */
function Notes({
  id,
  heading,
  label,
  value,
  field,
  className,
  placeholder,
  maxLength,
  spellCheck = true,
}: {
  id: Id;
  heading: string;
  label: string;
  value: string;
  field: "approach" | "solution";
  className: string;
  placeholder: string;
  maxLength: number;
  spellCheck?: boolean;
}) {
  const [text, setText] = useState(value);
  const patch = usePatchProblem();

  const dirty = text !== value;
  const headingId = `problem-${field}-heading`;

  return (
    <section aria-labelledby={headingId} className="mt-8">
      <div className="border-baseline flex items-baseline justify-between gap-3 border-b pb-2">
        <h3 id={headingId} className="label text-ink">
          {heading}
        </h3>
        <p aria-live="polite" className="label text-muted">
          {patch.isPending ? "saving" : patch.isError ? "" : dirty ? "unsaved" : ""}
        </p>
      </div>

      <textarea
        value={text}
        rows={field === "approach" ? 6 : 8}
        maxLength={maxLength}
        spellCheck={spellCheck}
        onChange={(event) => setText(event.target.value)}
        // Empty is null on the wire: an empty string is not a shorter note, it
        // is the absence of one, and the two must not both be storable.
        onBlur={() =>
          dirty && patch.mutate({ id, patch: { [field]: text.trim() === "" ? null : text } })
        }
        placeholder={placeholder}
        aria-label={label}
        className={`placeholder:text-faint mt-3 w-full resize-y ${className}`}
      />

      {patch.isError && (
        <p role="alert" className="text-warn text-meta mt-1">
          {(patch.error as Error).message}
        </p>
      )}
    </section>
  );
}

/**
 * The review line: one sentence about where this problem stands, and the one
 * action that changes it.
 *
 * Undo is offered in the same place, permanently, because a review you decide
 * was too shallow has to be as easy to take back as it was to claim — the row
 * simply rejoins the queue, and there is no third state to get stuck in.
 */
function Review({ problem }: { problem: Problem }) {
  const patch = usePatchProblem();

  /*
   * `reviewed_on`, NOT needsReview(). They answer different questions and the
   * difference is only visible on an archived row: needsReview() also asks
   * whether the problem is in the working list, so archiving an AI-assisted
   * problem that had not been reviewed made it "not waiting" — and this line
   * then read the other branch and formatted a null date, taking the whole pane
   * down with it. Whether it is in the queue is the list's question. Whether
   * you have been back to it is this one's, and only the date answers it.
   */
  const reviewed = problem.reviewed_on !== null;

  if (!problem.ai_assisted && !reviewed) {
    return (
      <p className="text-meta text-muted">Solved without AI help. Nothing waiting on this one.</p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
      <p className={`text-meta flex-1 ${needsReview(problem) ? "text-warn" : "text-muted"}`}>
        {reviewed
          ? `Reviewed ${formatDateShort(problem.reviewed_on as IsoDate)}.`
          : "Had AI help. Not been back to it yet."}
      </p>
      <button
        type="button"
        className={QUIET}
        disabled={patch.isPending}
        onClick={() => patch.mutate({ id: problem.id, patch: { reviewed: !reviewed } })}
      >
        {patch.isPending ? "Saving…" : reviewed ? "Undo review" : "Mark reviewed"}
      </button>
    </div>
  );
}

const DetailSkeleton = () => (
  <div className="grid gap-4">
    <Skeleton className="h-10 w-2/3" />
    <Skeleton className="h-56" />
    <Skeleton className="h-32" />
  </div>
);

export function ProblemDetail({
  id,
  today,
  vocabulary,
  siblings,
  onTopic,
}: {
  id: Id;
  today: IsoDate;
  vocabulary: string[];
  siblings: Problem[];
  /** Clicking a tag searches for it — which is the topic filter, without a second control. */
  onTopic: (topic: string) => void;
}) {
  const query = useProblem(id);
  const patch = usePatchProblem();
  const [editing, setEditing] = useState(false);

  if (query.isError && !query.data) {
    const gone = query.error instanceof ApiError && query.error.status === 404;
    return gone ? (
      <p className="text-muted">
        There is no problem with that id. It may have been recorded on another device.
      </p>
    ) : (
      <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
    );
  }

  if (!query.data) return <DetailSkeleton />;

  const problem = query.data.problem;
  const archived = problem.archived_at !== null;

  return (
    <article>
      <header>
        <p className="label text-muted">
          {/* The word, not a colour: hue identifies nothing in this product, and
              a green/amber/red pill would be the only thing on screen where it
              did — as well as the one difficulty reading a colour-blind reader
              could not make. */}
          {problem.difficulty}
          <span aria-hidden="true"> · </span>
          Solved {formatDateShort(problem.solved_on)}
          {archived && problem.archived_on && (
            <>
              <span aria-hidden="true"> · </span>
              <span className="text-warn">Archived {formatDateShort(problem.archived_on)}</span>
            </>
          )}
        </p>

        <h2 className="font-serif text-title mt-2 tracking-[-0.02em]">
          {problem.number !== null && (
            <span className="text-muted font-mono text-reg mr-3 align-middle">
              {problem.number}
            </span>
          )}
          {problem.title}
        </h2>

        {problem.topics.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            {problem.topics.map((topic) => (
              <li key={topic}>
                <button
                  type="button"
                  onClick={() => onTopic(topic)}
                  aria-label={`Find everything tagged ${topic}`}
                  className="label text-muted hover:text-ink min-h-8 transition-colors"
                >
                  {topic}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="border-grid mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 border-t pt-3">
          {problem.url && (
            <a
              href={problem.url}
              target="_blank"
              // noreferrer, not just noopener: this URL came from a text field
              // and the app has no business announcing itself to wherever it
              // points.
              rel="noreferrer"
              className={QUIET}
            >
              Open on LeetCode
            </a>
          )}
          <button type="button" className={QUIET} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            type="button"
            className={QUIET}
            disabled={patch.isPending}
            onClick={() => patch.mutate({ id: problem.id, patch: { archived: !archived } })}
          >
            {patch.isPending ? "Saving…" : archived ? "Restore" : "Archive"}
          </button>
        </div>
      </header>

      <div className="border-grid mt-4 border-t pt-4">
        <Review problem={problem} />
      </div>

      <section aria-labelledby="problem-statement-heading" className="mt-8">
        <h3 id="problem-statement-heading" className="label text-ink border-baseline border-b pb-2">
          Problem statement
        </h3>
        <div className="mt-3">
          {/* Paste has exactly one destination at a time: while the editor is
              open, it belongs to the dialog's own picker. */}
          <Screenshot problem={problem} pasteEnabled={!editing} />
        </div>
      </section>

      <Notes
        key={`approach-${problem.id}`}
        id={problem.id}
        field="approach"
        heading="My approach"
        label="My approach to this problem"
        value={problem.approach ?? ""}
        placeholder="What was the idea? What did you miss the first time?"
        maxLength={20000}
        className="ruled"
      />

      <Notes
        key={`solution-${problem.id}`}
        id={problem.id}
        field="solution"
        heading="Solution"
        label="The solution I kept"
        value={problem.solution ?? ""}
        placeholder="Optional."
        maxLength={40000}
        spellCheck={false}
        className="border-grid text-meta bg-canvas border p-3 font-mono focus:border-[var(--c-baseline)] focus:outline-none"
      />

      {editing && (
        <ProblemEditor
          problem={problem}
          today={today}
          vocabulary={vocabulary}
          siblings={siblings}
          onClose={() => setEditing(false)}
          onCreated={() => setEditing(false)}
        />
      )}
    </article>
  );
}
