-- 002_quantity.sql — quantity habits: the target becomes history.
--
-- v1 shipped three inert columns: habits.target_value, habits.unit and
-- habit_logs.value. This migration makes them mean something, and moves one of
-- them.
--
-- The move: target_value leaves habits and joins habit_schedules. A habit's
-- target changes over time exactly as its schedule does, and a habit-level
-- target silently re-scores every day that was already lived under a different
-- one. That is the same failure the versioned schedule was introduced to
-- prevent; the target has to be versioned for the same reason the days are.
--
-- What stays on habits is `unit`, which is the marker: unit IS NOT NULL means
-- the habit is measured. It cannot be target_value, because a paused version
-- stores no target and a quantity habit is still a quantity habit while paused.
--
-- Two invariants become uncheckable here and move to the API, which is a real
-- cost of the move and is recorded rather than glossed: "a target requires a
-- unit" and "a value requires a unit" both span two tables, and a CHECK cannot
-- contain a subquery.

-- ---------------------------------------------------------------------------
-- habit_schedules.target_value
-- ---------------------------------------------------------------------------

ALTER TABLE habit_schedules ADD COLUMN target_value numeric(10, 2);

COMMENT ON COLUMN habit_schedules.target_value IS
    'Amount asked for on one occasion, in habits.unit. NULL is valid: a quantity habit may measure without aiming, and a paused version asks for nothing.';

-- Backfill before any constraint exists. Copying to every non-paused version is
-- faithful rather than invented: under the old model one habit-level target
-- applied to the habit's whole history, so every version it spanned did ask for
-- it. Paused versions are excluded because the shape CHECK below forbids a
-- target on them, for the same reason they hold no days and no weekly target.
UPDATE habit_schedules s
   SET target_value = h.target_value
  FROM habits h
 WHERE h.id = s.habit_id
   AND h.target_value IS NOT NULL
   AND s.schedule_kind <> 'paused';

ALTER TABLE habit_schedules
    ADD CONSTRAINT habit_schedules_target_value_positive
        CHECK (target_value IS NULL OR target_value > 0);

-- habit_schedules_shape is an exact-match rule, so it is replaced rather than
-- extended: paused now also means no target. A pause asks for nothing at all,
-- and leaving a target on one would make "what does this habit want today?"
-- answerable during a span whose whole point is that it wants nothing.
ALTER TABLE habit_schedules DROP CONSTRAINT habit_schedules_shape;

ALTER TABLE habit_schedules
    ADD CONSTRAINT habit_schedules_shape
        CHECK (
            (schedule_kind = 'fixed'  AND schedule_days IS NOT NULL AND weekly_target IS NULL)
         OR (schedule_kind = 'weekly' AND weekly_target IS NOT NULL AND schedule_days IS NULL)
         OR (schedule_kind = 'paused' AND schedule_days IS NULL     AND weekly_target IS NULL
                                      AND target_value  IS NULL)
        );

-- ---------------------------------------------------------------------------
-- habits: the old target leaves, the unit gets a shape
-- ---------------------------------------------------------------------------

-- Dropping the column would drop both of these with it. Naming them is the
-- record of which rules ended, and why: habits_unit_requires_target asserted
-- that a unit was subordinate to a target, and the final model inverts that —
-- the unit is what makes a habit quantity-based, and the target is optional.
ALTER TABLE habits DROP CONSTRAINT habits_unit_requires_target;
ALTER TABLE habits DROP CONSTRAINT habits_target_value_positive;
ALTER TABLE habits DROP COLUMN target_value;

-- v1 never wrote a unit, so this normalises nothing in practice. It runs anyway
-- because the CHECK below is the first thing that has ever looked at the column,
-- and a migration that assumes its own table is empty is a migration that fails
-- on the one database that matters. A blank unit is repaired (it names nothing);
-- an over-long one is deliberately NOT truncated — silently shortening a label
-- someone chose is worse than failing loudly on data that cannot exist.
UPDATE habits SET unit = NULLIF(btrim(unit), '') WHERE unit IS NOT NULL;

ALTER TABLE habits
    ADD CONSTRAINT habits_unit_valid
        CHECK (unit IS NULL OR length(btrim(unit)) BETWEEN 1 AND 20);

COMMENT ON COLUMN habits.unit IS
    'The measured unit, free text ("km", "pages", "reps"). NULL means a binary habit: no target on any version, no value on any log. NOT NULL is the only marker that a habit is quantity-based — target_value cannot be, because a paused version has none. Immutable once any log carries a value (enforced by the API): values and targets are only ever comparable because the unit behind them never moved.';

-- ---------------------------------------------------------------------------
-- habit_logs.value
-- ---------------------------------------------------------------------------

-- 'done' with a measurement of zero has no reading — and the realistic cause of
-- it is someone typing 0 into a field that looked like it wanted a number when
-- they meant "I did not measure". NULL is what that means, so that is what the
-- repair writes. Again a no-op on v1 data, and again run rather than assumed.
UPDATE habit_logs SET value = NULL WHERE status = 'done' AND value = 0;

-- 'missed' and 'skipped' keep zero: "I tried and got nowhere" is a real claim,
-- and it is not the contradiction that done + 0 is. NULL value satisfies this
-- CHECK the way NULL satisfies every CHECK — unknown is never a violation.
ALTER TABLE habit_logs
    ADD CONSTRAINT habit_logs_done_value_not_zero
        CHECK (NOT (status = 'done' AND value = 0));

COMMENT ON COLUMN habit_logs.value IS
    'The measured amount, in the habit''s unit. NULL on every binary log, and valid on a quantity log too: "done, did not measure" is a first-class state. Recorded on missed and skipped as well, where it is a record and never a score.';
