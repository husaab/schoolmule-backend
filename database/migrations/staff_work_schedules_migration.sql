-- Staff work schedules — which weekdays a staff member works.
-- Run this migration against your Supabase PostgreSQL database. Safe to re-run.
--
-- Staff attendance assumes PRESENT on every open school day. Part-time staff
-- (e.g. Wednesdays and Fridays only) were therefore marked present on days they
-- never work. A row here is an admin's explicit override; without one, work
-- days are inferred from the schedule planner (the linked planner teacher's
-- working days plus any days they teach in the published timetable), and
-- failing that every open school day counts.

BEGIN;

CREATE TABLE IF NOT EXISTS staff_work_schedules (
  user_id     UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  school      public.school NOT NULL,
  -- ISO weekdays, Monday = 1 … Sunday = 7
  work_days   SMALLINT[] NOT NULL CHECK (
    cardinality(work_days) > 0 AND work_days <@ ARRAY[1,2,3,4,5,6,7]::SMALLINT[]
  ),
  updated_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_work_schedules_school ON staff_work_schedules(school);

COMMIT;
