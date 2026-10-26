-- Schedule planner v8 — schedules that carry their own bell times, and go-live dates.
-- Run this migration against your Supabase PostgreSQL database BEFORE deploying
-- the backend that reads these columns. Safe to re-run.
--
-- A school that changes its bell times for winter (daylight saving) keeps the
-- same timetable and copies it with new times. The copy carries its own breaks
-- and school hours (bell_times), so publishing it makes those the year's live
-- breaks/hours, and publishing the original again in March restores them.
-- go_live_on lets a copy publish itself just after midnight (America/Toronto).

BEGIN;

ALTER TABLE planner_schedules
  -- {"fixedBlocks":[{classGroupIds,label,dayOfWeek,startMin,endMin}],
  --  "dayTemplates":[{dayOfWeek,fillableRanges:[{startMin,endMin}]}]}
  -- NULL = this schedule uses the year's live breaks/hours (the old behaviour).
  ADD COLUMN IF NOT EXISTS bell_times JSONB,
  ADD COLUMN IF NOT EXISTS source_schedule_id UUID
    REFERENCES planner_schedules(schedule_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS go_live_on DATE,
  ADD COLUMN IF NOT EXISTS go_live_status VARCHAR(16)
    CHECK (go_live_status IN ('pending', 'running', 'done', 'failed')),
  ADD COLUMN IF NOT EXISTS go_live_attempts SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS go_live_error TEXT,
  -- Stamped by publish: the day a schedule became live, and the last day it
  -- was live once another replaced it.
  ADD COLUMN IF NOT EXISTS effective_from DATE,
  ADD COLUMN IF NOT EXISTS effective_to DATE;

-- The go-live worker scans only pending rows.
CREATE INDEX IF NOT EXISTS idx_planner_schedules_go_live
  ON planner_schedules (go_live_on) WHERE go_live_status = 'pending';

-- One scheduled go-live per school year, so two drafts can't race for the slot.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_planner_go_live_per_school_year
  ON planner_schedules (school, school_year_id) WHERE go_live_status IN ('pending', 'running');

-- Schedules already live get the day they went live.
UPDATE planner_schedules
SET effective_from = (published_at AT TIME ZONE 'America/Toronto')::date
WHERE status = 'published' AND effective_from IS NULL AND published_at IS NOT NULL;

COMMIT;
