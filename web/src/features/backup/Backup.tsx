/**
 * Your data: the download, and the way back in.
 *
 * The restore is the only destructive control in the app, so it is the only one
 * that asks twice — and the second ask is a summary of the file itself, checked
 * by the server, not a generic "are you sure". "Replace 7 habits, 412 logs and
 * 31 problems" is a sentence someone can actually disagree with; "this cannot
 * be undone" is one they click through.
 *
 * No queries and no cache: there is nothing here to keep fresh. Three plain
 * async handlers and a little state, and invalidateAll at the end because a
 * restore changes every screen at once.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Dialog } from "../../components/Dialog";
import { ErrorBox } from "../../components/ErrorBox";
import { PRIMARY, QUIET } from "../../components/form";
import { invalidateAll } from "../../lib/invalidate";
import { checkBackup, readLastBackup, restoreBackup, stampLastBackup } from "./api";
import type { BackupSummary } from "../../types";

/** The counts, in the order the document lists them, as words. */
function lines(counts: BackupSummary["counts"]): string[] {
  const say = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  return [
    say(counts.habits, "habit"),
    say(counts.habit_schedules, "schedule version"),
    say(counts.habit_logs, "logged day"),
    say(counts.tasks, "task"),
    say(counts.journal, "journal entry", "journal entries"),
    say(counts.leetcode_problems, "LeetCode problem"),
  ];
}

const fileInstant = (iso: string) => new Date(iso).toLocaleString();

export function Backup() {
  const client = useQueryClient();
  const [lastBackup, setLastBackup] = useState(readLastBackup);

  // The file that has been read and checked, waiting for a confirmation. The
  // document is held beside its summary so the confirm sends exactly what was
  // described — re-reading the file at that point would be a second file.
  const [pending, setPending] = useState<{ summary: BackupSummary; document: unknown } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  async function choose(file: File | undefined) {
    if (!file) return;
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      // Parsed here first, so a file that is not JSON at all says so straight
      // away rather than travelling to the server to be told the same thing.
      const document: unknown = JSON.parse(await file.text());
      setPending({ summary: await checkBackup(document), document });
    } catch (caught) {
      setError(caught instanceof SyntaxError ? new Error("That file is not JSON.") : caught);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const result = await restoreBackup(pending.document);
      setPending(null);
      setDone(`Restored ${lines(result.restored).join(", ")}.`);
      invalidateAll(client);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h3 className="label text-muted pb-2.5">Your data</h3>

      <div className="flex flex-wrap items-center gap-x-6">
        <a
          href="/api/export"
          download
          onClick={() => setLastBackup(stampLastBackup())}
          className={QUIET}
        >
          Download backup
        </a>

        {/* A label, not a button: the file input is the control, and dressing
            it as a label is what gets the native picker with no click-through
            script and no second focus target. */}
        <label className={`${QUIET} cursor-pointer`}>
          Restore backup
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            disabled={busy}
            onChange={(event) => {
              void choose(event.target.files?.[0]);
              // Cleared so choosing the SAME file again still fires a change.
              event.target.value = "";
            }}
          />
        </label>
      </div>

      <p className="text-meta text-muted mt-2">
        One JSON file with every habit, schedule version, logged day and note, your journal, tasks,
        LeetCode problems and reminder settings — archived ones included. LeetCode screenshots live
        in Cloudinary, so the file carries the reference to each image and not the image itself.
      </p>
      {lastBackup && (
        <p className="text-meta text-muted mt-2">Last downloaded {fileInstant(lastBackup)}.</p>
      )}
      {done && (
        <p role="status" className="text-meta text-ink mt-2">
          {done}
        </p>
      )}
      {error !== null && !pending && (
        <div className="mt-3 max-w-sm">
          <ErrorBox error={error} />
        </div>
      )}

      <Dialog open={pending !== null} onClose={() => setPending(null)} title="Restore backup">
        {pending && (
          <div className="grid gap-4">
            <p className="text-meta text-muted">
              From a backup taken {fileInstant(pending.summary.exported_at)}.
            </p>

            <ul className="text-ink grid gap-1">
              {lines(pending.summary.counts).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>

            {/* The warning is the whole reason this dialog exists. Said as what
                happens, not as an adjective: "everything currently in the app
                is deleted" is a fact, "this is dangerous" is an opinion. */}
            <p className="text-ink border-baseline border-t pt-4">
              Everything currently in the app is deleted and replaced with this file. There is no
              undo — if you have not downloaded a backup of what is here now, do that first.
            </p>

            {pending.summary.screenshots > 0 && (
              <p className="text-meta text-muted">
                {pending.summary.screenshots} problem
                {pending.summary.screenshots === 1 ? "" : "s"} reference a Cloudinary screenshot.
                The images are not in the file: they appear again only if this app still points at
                the Cloudinary account that holds them.
              </p>
            )}

            {error !== null && <ErrorBox error={error} />}

            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy}
              className={PRIMARY}
            >
              {busy ? "Restoring…" : "Replace everything"}
            </button>
          </div>
        )}
      </Dialog>
    </div>
  );
}
