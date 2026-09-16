-- 005_reminders.sql — optional reminders, and the settings that govern them.
--
-- Three columns and two small tables, rather than a generic notification or
-- event system. A reminder here is not an object with a lifecycle: it is a time
-- of day attached to a thing that already exists, and whether it is due is
-- recomputed on every check from the same facts every other read uses — the
-- schedule in force today, whether the task is still open, whether the review
-- queue is empty. Nothing about a reminder is stored twice, so nothing about it
-- can contradict the row it belongs to.
--
-- NULL is "no reminder". There is deliberately no separate enabled flag beside
-- the time: two columns for one fact is two columns that can disagree, and a
-- disabled reminder that still remembers its time is not worth a constraint.

-- ---------------------------------------------------------------------------
-- The per-thing reminder times
-- ---------------------------------------------------------------------------

-- `time` without a zone, on purpose: this is a wall-clock time in APP_TIMEZONE,
-- the same zone today() is resolved in. A timestamptz would pin the reminder to
-- an instant, which is exactly wrong for "remind me at eight" — eight is eight
-- on both sides of a DST transition, and an instant is not.
ALTER TABLE habits ADD COLUMN reminder_at time;

COMMENT ON COLUMN habits.reminder_at IS
    'Wall-clock time in APP_TIMEZONE to remind, or NULL for no reminder. Eligibility is still recomputed: a paused, archived or unscheduled day never notifies.';

ALTER TABLE tasks
    ADD COLUMN reminder_at time,
    -- An undated task waits under "Anytime" and is never overdue, so there is no
    -- day for a reminder to belong to. Enforced here rather than only in the
    -- API because clearing a due date is a separate statement from setting the
    -- reminder, and the pair must not be able to drift apart — updateTask()
    -- clears the reminder in the same statement that clears the date.
    ADD CONSTRAINT tasks_reminder_needs_date
        CHECK (reminder_at IS NULL OR due_date IS NOT NULL);

COMMENT ON COLUMN tasks.reminder_at IS
    'Wall-clock time in APP_TIMEZONE to remind, or NULL. Only a dated, open, unarchived task ever notifies.';

-- ---------------------------------------------------------------------------
-- app_settings — one row, forever
-- ---------------------------------------------------------------------------
--
-- Single user, so this is a singleton and says so in a constraint rather than
-- in a comment nobody reads. Typed columns rather than a JSONB blob: there are
-- six settings, they are not going to be user-defined, and a blob would give up
-- both the CHECK below and the export's readability for nothing.
CREATE TABLE app_settings (
    id                    smallint    PRIMARY KEY DEFAULT 1,
    -- The master switch. Off means nothing is ever delivered, whatever any
    -- individual reminder time says — so turning notifications off does not
    -- require unsetting a dozen times and then setting them all again.
    notifications_enabled boolean     NOT NULL DEFAULT false,
    habit_reminders       boolean     NOT NULL DEFAULT true,
    task_reminders        boolean     NOT NULL DEFAULT true,
    -- The LeetCode review reminder has no per-row home — the queue is a
    -- condition over the table, not a problem — so its time lives here. NULL is
    -- off, exactly as it is on a habit.
    leetcode_reminder_at  time,
    quiet_start           time,
    quiet_end             time,
    updated_at            timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT app_settings_singleton CHECK (id = 1),

    -- Both or neither. num_nonnulls rather than a chain of IS NULL comparisons,
    -- for the reason 004 gives: a CHECK that evaluates to NULL passes, and a
    -- half-filled row is exactly the one that makes those comparisons unknown.
    -- A window with one end is not a window, and the code would have to invent
    -- the other end — which is how 22:30 quietly becomes "all night".
    CONSTRAINT app_settings_quiet_hours_whole
        CHECK (num_nonnulls(quiet_start, quiet_end) IN (0, 2))
);

CREATE TRIGGER app_settings_set_updated_at
    BEFORE UPDATE ON app_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE app_settings IS
    'The single-user application settings. Exactly one row, id = 1.';

-- The row exists from here on, so every read is a plain SELECT and no caller
-- has to handle "not configured yet" as a separate state.
INSERT INTO app_settings (id) VALUES (1);

-- ---------------------------------------------------------------------------
-- reminder_deliveries — what has already been said
-- ---------------------------------------------------------------------------
--
-- The whole of duplicate prevention. The client asks the server what is due and
-- the server answers only with what it has not answered with before, because
-- claiming is the same statement as asking: INSERT ... ON CONFLICT DO NOTHING
-- RETURNING. A refresh, a second tab, a reopened app and a scheduler that ran
-- twice all lose the race in the database rather than in JavaScript, which is
-- the only place a single-user app can win it without inventing a lock.
--
-- The key is the thing being reminded about ('habit:12', 'task:9', 'leetcode')
-- and the date it was due on, so tomorrow's reminder is a different row and the
-- same one can never be sent twice in a day. It is not a foreign key: a
-- delivery is a record of something said, and deleting the habit afterwards
-- must not rewrite the past or fail.
CREATE TABLE reminder_deliveries (
    key     text        NOT NULL,
    on_date date        NOT NULL,
    sent_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (key, on_date)
);

COMMENT ON TABLE reminder_deliveries IS
    'One row per reminder actually delivered, keyed by thing and day. Swept after a week; it is dedupe state, not a record.';
