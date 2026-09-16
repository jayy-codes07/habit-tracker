-- 003_leetcode.sql — the LeetCode workspace: one table.
--
-- A personal learning record, not a scoreboard. Nothing here is scored, nothing
-- is aggregated into a rate, and there is no column a streak could be built
-- from. The product's rule that it states what happened rather than keeping
-- records applies with particular force to a table about studying: the moment a
-- "best" exists, deciding to go back over an old problem costs something.
--
-- The one workflow it encodes is REVIEW, and it is encoded as two facts rather
-- than as a status:
--
--     needs review  =  ai_assisted AND reviewed_on IS NULL
--
-- There is deliberately no review_status column. A stored status can disagree
-- with the facts that produce it — set ai_assisted false and a row claiming
-- 'needs_review' is a lie the schema permits. Two columns cannot contradict
-- themselves, and every read derives the queue from them.

-- CHECK cannot contain a subquery, so the per-element rules live in an
-- IMMUTABLE helper a CHECK is allowed to call — the same arrangement
-- habit_schedule_days_ok() uses for weekday arrays, and for the same reason.
CREATE OR REPLACE FUNCTION leetcode_topics_ok(topics text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT topics IS NOT NULL
       AND cardinality(topics) <= 8
       AND NOT EXISTS (
               SELECT 1 FROM unnest(topics) AS t
                WHERE length(btrim(t)) NOT BETWEEN 1 AND 30
           )
       -- Distinct, so a list cannot say "dp, dp". count(DISTINCT) rather than a
       -- unique index: this is a value inside one row, not a key across rows.
       AND cardinality(topics) = (SELECT count(DISTINCT t) FROM unnest(topics) AS t);
$$;

COMMENT ON FUNCTION leetcode_topics_ok(text[]) IS
    'True when the array holds 0-8 distinct tags, each 1-30 characters after trimming.';

-- ---------------------------------------------------------------------------
-- leetcode_problems
--
-- One row per solve. Not one row per problem: solving 146 again six months
-- later is a second thing that happened, and collapsing the two would destroy
-- the record of the first. `number` is therefore NOT unique, and the interface
-- warns about a repeat rather than the schema forbidding it.
--
-- The screenshot lives here as bytea rather than on disk. It is 1:1 with the
-- row, so on disk it could be orphaned and here it cannot; it rides the
-- database's backup rather than needing a second one; and Postgres TOASTs it
-- out of line automatically, so the list read — which never names the column —
-- never touches it. The cost is that the JSON export cannot carry it, which is
-- recorded in export.controller.js rather than glossed.
-- ---------------------------------------------------------------------------
CREATE TABLE leetcode_problems (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    number           integer,
    title            text        NOT NULL,
    difficulty       text        NOT NULL,
    topics           text[]      NOT NULL DEFAULT '{}',
    url              text,
    solved_on        date        NOT NULL,
    ai_assisted      boolean     NOT NULL DEFAULT false,
    reviewed_on      date,
    approach         text,
    solution         text,
    screenshot       bytea,
    screenshot_type  text,
    screenshot_bytes integer,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    archived_at      timestamptz,

    CONSTRAINT leetcode_problems_title_not_blank
        CHECK (length(btrim(title)) BETWEEN 1 AND 200),

    CONSTRAINT leetcode_problems_difficulty_valid
        CHECK (difficulty IN ('easy', 'medium', 'hard')),

    -- Nullable, because not every entry has one, but never zero or negative:
    -- a "#0" in the register is a typo that would read as a real problem.
    CONSTRAINT leetcode_problems_number_positive
        CHECK (number IS NULL OR number > 0),

    CONSTRAINT leetcode_problems_topics_valid
        CHECK (leetcode_topics_ok(topics)),

    -- Load-bearing rather than tidy. This value is rendered into an href, and
    -- without a scheme allowlist a stored 'javascript:...' becomes script
    -- execution on click. The API validates it too; this is the line that holds
    -- when a future controller forgets to.
    CONSTRAINT leetcode_problems_url_absolute
        CHECK (url IS NULL OR url ~ '^https?://'),

    -- Generous, because these are the point of the table, but bounded: an
    -- unbounded text column is how one paste puts a megabyte in a list query.
    CONSTRAINT leetcode_problems_approach_length
        CHECK (approach IS NULL OR length(approach) <= 20000),

    CONSTRAINT leetcode_problems_solution_length
        CHECK (solution IS NULL OR length(solution) <= 40000),

    -- All three or none. A blob with no content type cannot be served back —
    -- guessing one at read time is exactly the sniffing this app disables — and
    -- a type with no blob is a screenshot the interface would offer and 404 on.
    CONSTRAINT leetcode_problems_screenshot_whole
        CHECK (
            (screenshot IS NULL AND screenshot_type IS NULL AND screenshot_bytes IS NULL)
         OR (screenshot IS NOT NULL AND screenshot_type IS NOT NULL AND screenshot_bytes > 0)
        ),

    -- The allowlist is repeated here rather than left to the API because this
    -- column is echoed straight into a Content-Type header. SVG is absent on
    -- purpose: it is script-capable, and serving one back from the app's own
    -- origin would be stored XSS behind an <img> tag.
    CONSTRAINT leetcode_problems_screenshot_type_valid
        CHECK (screenshot_type IS NULL
               OR screenshot_type IN ('image/png', 'image/jpeg', 'image/webp'))
);

COMMENT ON TABLE leetcode_problems IS
    'One row per solve, not per problem. "Needs review" is derived: ai_assisted AND reviewed_on IS NULL.';

COMMENT ON COLUMN leetcode_problems.ai_assisted IS
    'I had significant help on this one. The only thing that puts a row in the review queue.';

COMMENT ON COLUMN leetcode_problems.reviewed_on IS
    'The day I went back over it, in APP_TIMEZONE. NULL means not yet — which is a queue, never a failure.';

COMMENT ON COLUMN leetcode_problems.screenshot IS
    'The problem statement as an image. TOASTed out of line, so reads that do not name it do not pay for it. Absent from the JSON export - pg_dump is the backup that carries it.';

COMMENT ON COLUMN leetcode_problems.number IS
    'The LeetCode number. Deliberately not unique: re-solving a problem is a second row, not an edit of the first.';

CREATE TRIGGER leetcode_problems_set_updated_at
    BEFORE UPDATE ON leetcode_problems
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- No index beyond the primary key, deliberately.
--
-- This is a single person's study log: a few hundred rows, read whole, filtered
-- and searched in the client. Every ordering this table has — solved_on DESC,
-- the review queue, the archived mirror — is a sequential scan of a few pages,
-- which is faster than an index lookup at this size and costs nothing on write.
-- Add one when the table passes a few thousand rows and not before; a partial
-- index on (solved_on DESC) WHERE archived_at IS NULL is the one to add.
