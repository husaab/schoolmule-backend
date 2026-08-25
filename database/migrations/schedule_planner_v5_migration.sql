-- Schedule Planner v5: per-course "max repeat days".
--
-- max_per_day caps how many sessions of a course may land on ONE day.
-- max_repeat_days caps how many DAYS may carry a repeat at all, i.e. how many
-- days hold two or more sessions of that course.
--
-- Worked example (Al Haadi): Grade 7 Math is 5 sessions/week taught by a teacher
-- who works 4 days, so a double-up somewhere is unavoidable. With max_per_day 2
-- alone the solver is free to pick 2+2+1+0 -- maths twice on two separate days.
-- max_repeat_days = 1 forces 2+1+1+1 instead: one doubled day, spread otherwise.
--
-- Nullable and opt-in: NULL = no limit, which is what every existing course keeps.

ALTER TABLE planner_courses
  ADD COLUMN IF NOT EXISTS max_repeat_days SMALLINT;

COMMENT ON COLUMN planner_courses.max_repeat_days IS
  'Max days per week that may hold 2+ sessions of this course. NULL = unlimited.';

-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so guard it to keep the whole
-- migration re-runnable like the ADD COLUMN above.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'planner_courses_max_repeat_days_nonneg'
      AND conrelid = 'planner_courses'::regclass
  ) THEN
    ALTER TABLE planner_courses
      ADD CONSTRAINT planner_courses_max_repeat_days_nonneg
      CHECK (max_repeat_days IS NULL OR max_repeat_days >= 0);
  END IF;
END $$;
