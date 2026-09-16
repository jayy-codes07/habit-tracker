/**
 * Everything a task is, in one sheet: what it says, when it is due, and whether
 * it should still exist.
 *
 * Removing is PATCH { archived: true } — the server has no DELETE for a task on
 * purpose. The way back is not here, because this sheet closes on removal: it
 * hands the removed task to the caller, which puts an undo bar on the spot and
 * keeps a "removed" drawer — its own read of scope=archived — to restore from
 * later. Both undo by PATCHing { archived: false } back.
 *
 * The due date is the one field that can be cleared as well as changed, and the
 * API distinguishes the two: omitting `due_date` leaves it alone, sending null
 * clears it. An empty <input type="date"> is exactly that null.
 */
import { useState } from "react";

import { Dialog } from "../../components/Dialog";
import { FIELD, PRIMARY, QUIET } from "../../components/form";
import { usePatchTask } from "./queries";
import type { IsoDate, Task } from "../../types";

export function TaskEditor({
  task,
  onClose,
  onRemoved,
}: {
  task: Task;
  onClose: () => void;
  onRemoved: (task: Task) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [due, setDue] = useState<IsoDate | "">(task.due_date ?? "");
  // "" is no reminder, and an undated task can have none at all — the server
  // clears it with the date, so the field goes with it rather than pretending.
  const [reminder, setReminder] = useState(task.reminder_at ?? "");

  const patch = usePatchTask();

  const trimmed = title.trim();
  const nextDue = due === "" ? null : due;
  // Dropping the date drops the reminder with it, here as on the server.
  const nextReminder = nextDue === null || reminder === "" ? null : reminder;
  const changed =
    trimmed !== task.title || nextDue !== task.due_date || nextReminder !== task.reminder_at;

  const save = () =>
    patch.mutate(
      {
        id: task.id,
        patch: {
          ...(trimmed !== task.title ? { title: trimmed } : {}),
          // Always sent when it changed, null included — that is how the API is
          // told to clear it rather than leave it.
          ...(nextDue !== task.due_date ? { due_date: nextDue } : {}),
          ...(nextReminder !== task.reminder_at ? { reminder_at: nextReminder } : {}),
        },
      },
      { onSuccess: onClose },
    );

  return (
    <Dialog open onClose={onClose} title={task.title}>
      <div className="grid gap-5">
        <div>
          <label htmlFor="task-title" className="label text-muted block pb-2.5">
            Task
          </label>
          <input
            id="task-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            className={FIELD}
          />
        </div>

        <div>
          <label htmlFor="task-due" className="label text-muted block pb-2.5">
            Due
          </label>
          <div className="flex gap-2">
            <input
              id="task-due"
              type="date"
              value={due}
              onChange={(event) => setDue(event.target.value)}
              className={FIELD}
            />
            {due !== "" && (
              <button
                type="button"
                onClick={() => setDue("")}
                className="label min-h-12 shrink-0 px-2 underline decoration-[var(--c-baseline)] underline-offset-[6px]"
              >
                Clear
              </button>
            )}
          </div>
          <p className="text-meta text-muted mt-1.5">
            {due === ""
              ? "With no date it waits under Anytime, and never counts as overdue."
              : "A date is when you meant to do it. It is never rewritten for you."}
          </p>
        </div>

        {/* Only for a dated task. An undated one waits under Anytime and is
            never overdue, so there is no day a reminder could belong to —
            offering the field and then dropping what it holds would be worse
            than not offering it. */}
        {due !== "" && (
          <div>
            <label htmlFor="task-reminder" className="label text-muted block pb-2.5">
              Reminder (optional)
            </label>
            <div className="flex gap-2">
              <input
                id="task-reminder"
                type="time"
                value={reminder}
                onChange={(event) => setReminder(event.target.value)}
                className={FIELD}
              />
              {reminder !== "" && (
                <button
                  type="button"
                  onClick={() => setReminder("")}
                  className="label min-h-12 shrink-0 px-2 underline decoration-[var(--c-baseline)] underline-offset-[6px]"
                >
                  Clear
                </button>
              )}
            </div>
            <p className="text-meta text-muted mt-1.5">
              Once, on the day it is due, and only while it is still open. It is not repeated after
              the day has passed — the date is never rewritten for you.
            </p>
          </div>
        )}

        {patch.isError && (
          <p role="alert" className="text-warn text-meta">
            {patch.error.message}
          </p>
        )}

        <div className="grid gap-2">
          <button
            type="button"
            className={PRIMARY}
            disabled={!trimmed || !changed || patch.isPending}
            onClick={save}
          >
            {patch.isPending ? "Saving…" : changed ? "Save changes" : "Saved"}
          </button>
          <button type="button" className={QUIET} onClick={onClose}>
            Cancel
          </button>
        </div>

        <div className="border-grid grid gap-2 border-t pt-4">
          <button
            type="button"
            className={QUIET}
            disabled={patch.isPending}
            onClick={() =>
              patch.mutate(
                { id: task.id, patch: { archived: true } },
                {
                  onSuccess: () => {
                    onRemoved(task);
                    onClose();
                  },
                },
              )
            }
          >
            Remove this task
          </button>
          <p className="text-meta text-muted">
            It leaves every list but is never destroyed — it stays in your export. You can undo this
            straight away; afterwards there is no screen that lists it again.
          </p>
        </div>
      </div>
    </Dialog>
  );
}
