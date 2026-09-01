-- Schedule planner v6 — teacher-facing schedule surfaces.
-- Run this migration against your Supabase PostgreSQL database.
--
-- Publishing already materializes sessions into planner_schedule_sessions so
-- teachers can read their own timetable without touching admin-gated config.
-- Fixed blocks (Snack, Lunch, Salat) were never materialized, so a teacher's
-- day view rendered periods with nothing between them. This snapshots them
-- alongside the sessions, on the same publish transaction.

BEGIN;

CREATE TABLE IF NOT EXISTS planner_schedule_fixed_blocks (
  snapshot_block_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id        UUID NOT NULL REFERENCES planner_schedules(schedule_id) ON DELETE CASCADE,
  school             public.school NOT NULL,
  school_id          UUID REFERENCES schools(school_id),
  -- Empty array = whole school. Mirrors planner_fixed_blocks.class_group_ids
  -- (v2 moved this from a single nullable group to an array for staggered lunches).
  class_group_ids    JSONB NOT NULL DEFAULT '[]'::jsonb,
  label              VARCHAR(255) NOT NULL,
  day_of_week        SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_min          SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min            SMALLINT NOT NULL CHECK (end_min > start_min AND end_min <= 1440),
  school_year_id     UUID REFERENCES school_years(school_year_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_psfb_schedule ON planner_schedule_fixed_blocks(schedule_id);

COMMIT;
