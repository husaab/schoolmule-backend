-- Schedule Planner v2 Migration
-- Run AFTER schedule_planner_migration.sql (alters existing tables).
--
-- 1. Teachers: optional daily spare rule — a contiguous free window (in
--    minutes) required on any day the teacher teaches.
-- 2. Fixed blocks: apply to a SET of class groups instead of a single one.
--    class_group_id (UUID, NULL = school-wide) is replaced by
--    class_group_ids (JSONB array of class_group_id strings, [] = school-wide).

-- 1. Teacher daily spare
ALTER TABLE planner_teachers
  ADD COLUMN IF NOT EXISTS daily_spare_minutes SMALLINT
  CHECK (daily_spare_minutes IS NULL OR daily_spare_minutes > 0);

-- 2. Multi-group fixed blocks
ALTER TABLE planner_fixed_blocks
  ADD COLUMN IF NOT EXISTS class_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Carry over any existing single-group scoping
UPDATE planner_fixed_blocks
SET class_group_ids = jsonb_build_array(class_group_id)
WHERE class_group_id IS NOT NULL
  AND class_group_ids = '[]'::jsonb;

ALTER TABLE planner_fixed_blocks
  DROP COLUMN IF EXISTS class_group_id;
