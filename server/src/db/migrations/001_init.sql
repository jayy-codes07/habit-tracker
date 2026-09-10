-- 001_init.sql — habit tracker v1 schema.
--
-- Conventions:
--   * Calendar dates use DATE. They are never timestamps: a habit is done on a
--     day, not at an instant, and storing an instant reintroduces timezone drift.
--   * Event instants (created_at, archived_at, completed_at) use TIMESTAMPTZ.
--   * Weekdays are ISO-8601: 1 = Monday ... 7 = Sunday, matching Postgres ISODOW
--     and the Monday week start used throughout the product.

-- The migration runner creates this too, so it can read the applied list before
-- any migration has run. Kept here so the schema file describes the whole schema.
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text        PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

-- CHECK constraints cannot contain subqueries, and there is no built-in
-- array-distinct in PG16, so the "no duplicate weekdays" rule lives in an
-- IMMUTABLE helper that a CHECK is allowed to call.
CREATE OR REPLACE FUNCTION habit_schedule_days_ok(days smallint[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT days IS NULL
        OR (
            cardinality(days) BETWEEN 1 AND 7
            AND days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
            AND cardinality(days) = (SELECT count(DISTINCT d) FROM unnest(days) AS d)
        );
$$;

COMMENT ON FUNCTION habit_schedule_days_ok(smallint[]) IS
    'True when the array is NULL, or holds 1-7 distinct ISO weekday values (1=Mon).';

CREATE TABLE habits (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          text        NOT NULL,
    color_token   text        NOT NULL,
    schedule_kind text        NOT NULL,
    schedule_days smallint[],
    weekly_target smallint,
    sort_order    integer     NOT NULL DEFAULT 0,
    start_date    date        NOT NULL,
    target_value  numeric(10, 2),          -- quantity habits are v2; NULL in v1
    unit          text,                    -- quantity habits are v2; NULL in v1
    created_at    timestamptz NOT NULL DEFAULT now(),
    archived_at   timestamptz,

    CONSTRAINT habits_name_not_blank
        CHECK (length(btrim(name)) BETWEEN 1 AND 80),

    -- Colors are theme tokens, never hex, so both themes stay legible.
    CONSTRAINT habits_color_token_valid
        CHECK (color_token IN ('chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5')),

    CONSTRAINT habits_schedule_kind_valid
        CHECK (schedule_kind IN ('fixed', 'weekly')),

    CONSTRAINT habits_schedule_days_valid
        CHECK (habit_schedule_days_ok(schedule_days)),

    CONSTRAINT habits_weekly_target_range
        CHECK (weekly_target IS NULL OR weekly_target BETWEEN 1 AND 7),

    -- The pair of rules that makes an invalid schedule impossible to store:
    -- fixed needs days and no target; weekly needs a target and no days.
    CONSTRAINT habits_schedule_shape
        CHECK (
            (schedule_kind = 'fixed'  AND schedule_days IS NOT NULL AND weekly_target IS NULL)
         OR (schedule_kind = 'weekly' AND weekly_target IS NOT NULL AND schedule_days IS NULL)
        ),

    CONSTRAINT habits_target_value_positive
        CHECK (target_value IS NULL OR target_value > 0),

    -- A unit with nothing to measure is meaningless.
    CONSTRAINT habits_unit_requires_target
        CHECK (unit IS NULL OR target_value IS NOT NULL)
);

COMMENT ON COLUMN habits.schedule_days IS 'ISO weekdays, 1=Monday..7=Sunday. Set only when schedule_kind = fixed.';
COMMENT ON COLUMN habits.weekly_target IS 'Times per week. Set only when schedule_kind = weekly.';
COMMENT ON COLUMN habits.target_value  IS 'Quantity habits (v2). NULL in v1.';

CREATE TABLE habit_logs (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    habit_id  bigint  NOT NULL REFERENCES habits (id) ON DELETE CASCADE,
    date      date    NOT NULL,
    completed boolean NOT NULL DEFAULT false,
    value     numeric(10, 2),              -- quantity habits are v2; NULL in v1
    note      text,

    CONSTRAINT habit_logs_unique_day UNIQUE (habit_id, date),

    CONSTRAINT habit_logs_value_non_negative
        CHECK (value IS NULL OR value >= 0),

    CONSTRAINT habit_logs_note_length
        CHECK (note IS NULL OR length(note) <= 1000)
);

CREATE TABLE tasks (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title        text        NOT NULL,
    due_date     date,
    completed    boolean     NOT NULL DEFAULT false,
    completed_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    archived_at  timestamptz,

    CONSTRAINT tasks_title_not_blank
        CHECK (length(btrim(title)) BETWEEN 1 AND 200),

    -- completed and completed_at can never disagree.
    CONSTRAINT tasks_completed_consistent
        CHECK (completed = (completed_at IS NOT NULL))
);

CREATE TABLE journal (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    date  date NOT NULL,
    kind  text NOT NULL,
    entry text NOT NULL,

    CONSTRAINT journal_unique_entry UNIQUE (date, kind),

    CONSTRAINT journal_kind_valid
        CHECK (kind IN ('day', 'month')),

    CONSTRAINT journal_entry_not_blank
        CHECK (length(btrim(entry)) > 0),

    -- Monthly reflections are keyed to the first of their month.
    CONSTRAINT journal_month_anchored
        CHECK (kind <> 'month' OR EXTRACT(DAY FROM date) = 1)
);

COMMENT ON TABLE journal IS 'Daily one-liners (kind=day) and monthly reflections (kind=month, dated the 1st).';

-- Indexes.
--
-- habit_logs (habit_id, date) and journal (date, kind) are NOT created here:
-- their UNIQUE constraints already build exactly those btrees, and a duplicate
-- index costs writes and space for nothing.

-- "What happened on this date?" across every habit — the day screen's read.
CREATE INDEX habit_logs_date_idx ON habit_logs (date);

-- Open tasks by due date; partial, because completed tasks are never queried this way.
CREATE INDEX tasks_due_date_open_idx ON tasks (due_date) WHERE NOT completed;

-- The active habit list, in display order.
CREATE INDEX habits_active_order_idx ON habits (sort_order, id) WHERE archived_at IS NULL;
