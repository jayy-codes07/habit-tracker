-- 004_leetcode_cloudinary.sql — the screenshot moves out of the database.
--
-- 003 stored the problem statement as bytea, and the reasoning there still
-- holds for what it was optimising: the image could not be orphaned and it rode
-- pg_dump. What it cost was the one thing this table is for backing up — the
-- JSON export could not carry an image, because res.json() builds the whole
-- document in memory and a few hundred statements is a few hundred megabytes.
--
-- Cloudinary holds the bytes now and Postgres holds the reference. The export
-- carries that reference in full, so a restored row still points at its image.
-- The orphan risk bytea removed comes back and is handled where it happens:
-- leetcode.service.js destroys an upload whose row write failed, destroys the
-- previous asset after a replacement lands, and refuses to clear the row if
-- Cloudinary would not delete.
--
-- Nothing is migrated. There are no stored screenshots outside development, and
-- bytes cannot be pushed to a third party from inside a migration transaction
-- anyway — a dev database with images in it re-pastes them.

ALTER TABLE leetcode_problems
    DROP CONSTRAINT leetcode_problems_screenshot_whole,
    DROP CONSTRAINT leetcode_problems_screenshot_type_valid,
    DROP COLUMN screenshot,
    DROP COLUMN screenshot_type,
    ADD COLUMN screenshot_public_id text,
    ADD COLUMN screenshot_format    text,
    ADD COLUMN screenshot_width     integer,
    ADD COLUMN screenshot_height    integer;

-- Any row that had an image had it as bytea, and the bytea is being dropped:
-- what is left is a size with nothing behind it, which the constraint below
-- would refuse. The reference columns are all NULL for those rows, so this is
-- the same statement as "it has no screenshot now" - which is true, and the
-- screenshot is re-pasted.
UPDATE leetcode_problems SET screenshot_bytes = NULL WHERE screenshot_bytes IS NOT NULL;

-- All five or none, for the reason the bytea version had the same rule: the
-- public_id alone is what the URL is built from, and a row carrying dimensions
-- with nothing to fetch is a screenshot the interface would offer and 404 on.
-- The format allowlist stays a constraint rather than only an API check —
-- Cloudinary will deliver whatever it stored, and svg is script-capable.
ALTER TABLE leetcode_problems
    ADD CONSTRAINT leetcode_problems_screenshot_whole
        CHECK (
            -- num_nonnulls rather than a chain of IS NULL / IS NOT NULL: a CHECK
            -- that evaluates to NULL passes, and half-filled rows are exactly
            -- the ones that make the comparisons unknown. Counting cannot be
            -- unknown.
            num_nonnulls(screenshot_public_id, screenshot_format, screenshot_width,
                         screenshot_height, screenshot_bytes) IN (0, 5)
            AND (screenshot_public_id IS NULL
                 OR (screenshot_width > 0 AND screenshot_height > 0
                     AND screenshot_bytes > 0))
        ),
    ADD CONSTRAINT leetcode_problems_screenshot_format_valid
        CHECK (screenshot_format IS NULL OR screenshot_format IN ('png', 'jpg', 'webp'));

COMMENT ON COLUMN leetcode_problems.screenshot_public_id IS
    'The Cloudinary asset holding the problem statement. The URLs are derived from it - see lib/cloudinary/url.js - so nothing here can go stale.';
