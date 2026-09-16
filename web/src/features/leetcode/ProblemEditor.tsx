/**
 * What a problem IS — the facts, in one sheet.
 *
 * Deliberately not what a problem MEANS. `approach` and `solution` are offered
 * here only when recording a new one, where there is no screen behind the
 * dialog to type them on; once the problem exists they are edited in place on
 * its own page, because writing is the thing you come back to do and putting it
 * behind a modal taxes it every time. Two editors for one field is how they
 * start disagreeing, so there is exactly one for each.
 *
 * The screenshot is here for the same reason: on a new problem there is no id
 * to upload to yet, so the file is held and sent the moment one exists. On an
 * existing problem the plate on the page owns it.
 */
import { useState, type FormEvent } from "react";

import { ScreenshotPicker } from "./Screenshot";
import { DIFFICULTIES, parseTopics } from "./problems";
import { useCreateProblem, usePatchProblem, useSetScreenshot } from "./queries";
import { Choice } from "../../components/Choice";
import { Dialog } from "../../components/Dialog";
import { FIELD, PRIMARY, QUIET } from "../../components/form";
import { formatDateShort } from "../../lib/dates";
import type { Difficulty, IsoDate, Problem } from "../../types";

/** A value that may be cleared, as the API wants it: "" on screen, null on the wire. */
const orNull = (value: string) => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

export function ProblemEditor({
  problem,
  today,
  vocabulary,
  siblings,
  onClose,
  onCreated,
}: {
  /** The problem being edited, or null to record a new one. */
  problem: Problem | null;
  today: IsoDate;
  /** Every tag already in use, for the topics field's native autocomplete. */
  vocabulary: string[];
  /** The working list, read only to notice a number that is already recorded. */
  siblings: Problem[];
  onClose: () => void;
  onCreated: (problem: Problem) => void;
}) {
  const [number, setNumber] = useState(
    problem?.number === null ? "" : String(problem?.number ?? ""),
  );
  const [title, setTitle] = useState(problem?.title ?? "");
  const [difficulty, setDifficulty] = useState<Difficulty>(problem?.difficulty ?? "medium");
  const [topics, setTopics] = useState((problem?.topics ?? []).join(", "));
  const [url, setUrl] = useState(problem?.url ?? "");
  const [solvedOn, setSolvedOn] = useState<IsoDate>(problem?.solved_on ?? today);
  const [aiAssisted, setAiAssisted] = useState(problem?.ai_assisted ?? false);
  const [approach, setApproach] = useState("");
  const [solution, setSolution] = useState("");
  const [file, setFile] = useState<File | null>(null);

  /**
   * The problem was created and its screenshot was not. It exists, so the
   * dialog stops offering to create it again and offers the way to it instead —
   * closing on a half-done save would look exactly like a save that worked.
   */
  const [orphaned, setOrphaned] = useState<Problem | null>(null);

  const create = useCreateProblem();
  const patch = usePatchProblem();
  const upload = useSetScreenshot();

  const trimmed = title.trim();
  const busy = create.isPending || patch.isPending || upload.isPending;

  /**
   * Not a blocker. Solving the same problem twice is a real thing and a second
   * entry is the honest record of it — but so is mistyping a number you already
   * have, and only you can tell which this is.
   */
  const duplicate =
    number !== "" && problem === null
      ? (siblings.find((row) => String(row.number) === number) ?? null)
      : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || busy) return;

    const fields = {
      number: number === "" ? null : Number(number),
      title: trimmed,
      difficulty,
      topics: parseTopics(topics),
      url: orNull(url),
      solved_on: solvedOn,
      ai_assisted: aiAssisted,
    };

    if (problem !== null) {
      patch.mutate({ id: problem.id, patch: fields }, { onSuccess: onClose });
      return;
    }

    try {
      const created = (
        await create.mutateAsync({
          ...fields,
          approach: orNull(approach),
          solution: orNull(solution),
        })
      ).problem;

      if (file !== null) {
        try {
          await upload.mutateAsync({ id: created.id, file });
        } catch {
          // The upload's own error renders below; the problem is real and the
          // dialog now points at it rather than pretending nothing happened.
          setOrphaned(created);
          return;
        }
      }

      onCreated(created);
    } catch {
      // create.error renders below.
    }
  };

  const failed = (create.error ?? patch.error ?? upload.error) as Error | null;

  return (
    <Dialog open onClose={onClose} title={problem === null ? "Record a problem" : problem.title}>
      {orphaned !== null ? (
        <div className="grid gap-4">
          <p className="text-ui">
            “{orphaned.title}” was saved, but its screenshot did not upload. Open it and paste the
            image again — nothing else was lost.
          </p>
          <button type="button" className={PRIMARY} onClick={() => onCreated(orphaned)}>
            Open the problem
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="grid gap-5">
          <div className="flex gap-4">
            <div className="w-24 shrink-0">
              <label htmlFor="problem-number" className="label text-muted block pb-2.5">
                Number
              </label>
              <input
                id="problem-number"
                value={number}
                inputMode="numeric"
                placeholder="146"
                // Digits only, so the field cannot hold something the API will
                // reject after everything else has been typed.
                onChange={(event) => {
                  if (/^\d*$/.test(event.target.value)) setNumber(event.target.value);
                }}
                maxLength={7}
                className={`${FIELD} font-mono`}
              />
            </div>
            <div className="min-w-0 flex-1">
              <label htmlFor="problem-title" className="label text-muted block pb-2.5">
                Title
              </label>
              <input
                id="problem-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
                autoFocus
                className={FIELD}
              />
            </div>
          </div>

          {duplicate && (
            <p className="text-meta text-muted -mt-2">
              You already have #{duplicate.number} — “{duplicate.title}”, solved{" "}
              {formatDateShort(duplicate.solved_on)}. Recording it again is a second solve, not an
              edit of the first.
            </p>
          )}

          <fieldset>
            <legend className="label text-muted pb-2.5">Difficulty</legend>
            {/* flex and no gap: the positions share one rule, and a gap would
                break the scale into three separate objects. */}
            <div className="flex">
              {DIFFICULTIES.map((level) => (
                <Choice
                  key={level}
                  type="radio"
                  name="problem-difficulty"
                  checked={difficulty === level}
                  onChange={() => setDifficulty(level)}
                  label={level}
                >
                  {level}
                </Choice>
              ))}
            </div>
          </fieldset>

          <div>
            <label htmlFor="problem-topics" className="label text-muted block pb-2.5">
              Topics
            </label>
            <input
              id="problem-topics"
              value={topics}
              onChange={(event) => setTopics(event.target.value)}
              list="problem-topic-vocabulary"
              placeholder="hash-table, design"
              className={FIELD}
            />
            {/* A native datalist rather than a combobox component: the whole
                feature is three lines and the platform already does the
                filtering, the keyboard and the announcement. */}
            <datalist id="problem-topic-vocabulary">
              {vocabulary.map((topic) => (
                <option key={topic} value={topic} />
              ))}
            </datalist>
            <p className="text-meta text-muted mt-1.5">Separated by commas. Up to eight.</p>
          </div>

          <div>
            <label htmlFor="problem-url" className="label text-muted block pb-2.5">
              Link
            </label>
            <input
              id="problem-url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://leetcode.com/problems/…"
              maxLength={500}
              className={FIELD}
            />
          </div>

          <div>
            <label htmlFor="problem-solved" className="label text-muted block pb-2.5">
              Solved
            </label>
            <input
              id="problem-solved"
              type="date"
              value={solvedOn}
              onChange={(event) => setSolvedOn(event.target.value)}
              className={FIELD}
            />
          </div>

          {/* The one field the whole review workflow turns on. It is a plain
              statement of what happened, not a confession: the queue it feeds
              exists to be worked through, and nothing counts it. */}
          <label className="border-grid flex cursor-pointer items-start gap-3 border-t pt-4">
            <input
              type="checkbox"
              checked={aiAssisted}
              onChange={() => setAiAssisted(!aiAssisted)}
              className="sr-only"
            />
            <span
              aria-hidden="true"
              className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center border-[1.5px] transition-colors ${
                aiAssisted ? "bg-ink border-ink text-canvas" : "border-baseline"
              }`}
            >
              {aiAssisted && (
                <svg
                  viewBox="0 0 12 12"
                  className="h-3 w-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M2.2 6.2 4.8 8.8 9.8 3.2" />
                </svg>
              )}
            </span>
            <span className="min-w-0">
              <span className="text-ui block">I had significant AI help</span>
              <span className="text-meta text-muted block">
                It goes on the Needs review list until you have been back over it.
              </span>
            </span>
          </label>

          {problem === null && (
            <>
              <div>
                <span className="label text-muted block pb-2.5">Problem statement</span>
                <ScreenshotPicker file={file} onFile={setFile} onClear={() => setFile(null)} />
              </div>

              <div>
                <label htmlFor="problem-approach" className="label text-muted block pb-2.5">
                  My approach
                </label>
                <textarea
                  id="problem-approach"
                  value={approach}
                  onChange={(event) => setApproach(event.target.value)}
                  rows={4}
                  maxLength={20000}
                  className="ruled w-full resize-y"
                />
              </div>

              <div>
                <label htmlFor="problem-solution" className="label text-muted block pb-2.5">
                  Solution
                </label>
                <textarea
                  id="problem-solution"
                  value={solution}
                  onChange={(event) => setSolution(event.target.value)}
                  rows={4}
                  maxLength={40000}
                  spellCheck={false}
                  className="border-grid text-meta bg-canvas w-full resize-y border p-3 font-mono outline-none focus:border-[var(--c-baseline)]"
                />
              </div>
            </>
          )}

          {failed && (
            <p role="alert" className="text-warn text-meta">
              {failed.message}
            </p>
          )}

          <div className="grid gap-2">
            <button type="submit" className={PRIMARY} disabled={!trimmed || busy}>
              {busy ? "Saving…" : problem === null ? "Record it" : "Save changes"}
            </button>
            <button type="button" className={QUIET} onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
