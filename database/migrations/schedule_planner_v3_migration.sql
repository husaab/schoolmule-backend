-- Schedule Planner v3 Migration
-- Run AFTER schedule_planner_v2_migration.sql (and the school-year migration).
--
-- 1. Teachers: optional cap on distinct working days per week.
-- 2. Period rules: window-based scheduling rules the generator enforces:
--      kind = 'teach' -> class_group's sessions inside [start_min, end_min)
--                        must be taught by teacher_id on >= min_per_week days
--                        (homeroom mornings, "sees them 4x/week first period")
--      kind = 'free'  -> teacher_id keeps >= min_per_week period-slots free
--                        inside the window across the week (ESL pull-outs)

ALTER TABLE planner_teachers
  ADD COLUMN IF NOT EXISTS max_days_per_week SMALLINT
  CHECK (max_days_per_week IS NULL OR max_days_per_week BETWEEN 1 AND 7);

CREATE TABLE IF NOT EXISTS planner_period_rules (
  rule_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school         public.school NOT NULL,
  school_id      UUID REFERENCES schools(school_id),
  school_year_id UUID REFERENCES school_years(school_year_id),
  teacher_id     UUID NOT NULL REFERENCES planner_teachers(planner_teacher_id) ON DELETE CASCADE,
  class_group_id UUID REFERENCES planner_class_groups(class_group_id) ON DELETE CASCADE,
  kind           VARCHAR(10) NOT NULL CHECK (kind IN ('teach', 'free')),
  start_min      SMALLINT NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min        SMALLINT NOT NULL CHECK (end_min > start_min AND end_min <= 1440),
  min_per_week   SMALLINT NOT NULL CHECK (min_per_week BETWEEN 1 AND 7),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT teach_rules_need_class CHECK (kind != 'teach' OR class_group_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_planner_period_rules_school
  ON planner_period_rules(school, school_year_id);
