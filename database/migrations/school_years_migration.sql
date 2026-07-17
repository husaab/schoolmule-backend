-- School-year scoping migration. Additive + backfill only; no destructive steps.
BEGIN;

CREATE TABLE IF NOT EXISTS school_years (
  school_year_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school               public.school NOT NULL,
  school_id            uuid NOT NULL REFERENCES schools(school_id) ON DELETE CASCADE,
  label                varchar(9) NOT NULL,
  start_date           date NOT NULL,
  end_date             date NOT NULL,
  is_active            boolean NOT NULL DEFAULT false,
  created_from_year_id uuid REFERENCES school_years(school_year_id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, label)
);

CREATE UNIQUE INDEX IF NOT EXISTS school_years_one_active_per_school
  ON school_years (school_id) WHERE is_active;

-- Seed the current year (2025-2026) for every registered school, active.
INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
SELECT s.school_code, s.school_id, '2025-2026',
       COALESCE(s.academic_year_start_date, DATE '2025-09-01'),
       COALESCE(s.academic_year_end_date,   DATE '2026-06-30'),
       TRUE
FROM schools s
ON CONFLICT (school_id, label) DO NOTHING;

-- ============ students ============
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS school_year_id uuid REFERENCES school_years(school_year_id),
  ADD COLUMN IF NOT EXISTS previous_student_id uuid REFERENCES students(student_id);
UPDATE students st SET school_year_id = sy.school_year_id
FROM school_years sy
WHERE sy.school = st.school AND sy.label = '2025-2026' AND st.school_year_id IS NULL;
ALTER TABLE students ALTER COLUMN school_year_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_students_school_year ON students (school, school_year_id);

-- ============ classes ============
ALTER TABLE classes
  ADD COLUMN IF NOT EXISTS school_year_id uuid REFERENCES school_years(school_year_id);
UPDATE classes c SET school_year_id = sy.school_year_id
FROM school_years sy
WHERE sy.school = c.school AND sy.label = '2025-2026' AND c.school_year_id IS NULL;
ALTER TABLE classes ALTER COLUMN school_year_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_classes_school_year ON classes (school, school_year_id);

-- ============ terms ============
ALTER TABLE terms
  ADD COLUMN IF NOT EXISTS school_year_id uuid REFERENCES school_years(school_year_id);
-- match by academic_year label first, then fall back to 2025-2026
UPDATE terms t SET school_year_id = sy.school_year_id
FROM school_years sy
WHERE sy.school = t.school AND sy.label = t.academic_year AND t.school_year_id IS NULL;
UPDATE terms t SET school_year_id = sy.school_year_id
FROM school_years sy
WHERE sy.school = t.school AND sy.label = '2025-2026' AND t.school_year_id IS NULL;
ALTER TABLE terms ALTER COLUMN school_year_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_terms_school_year ON terms (school, school_year_id);

-- ============ planner tables (9) ============
ALTER TABLE planner_settings          ADD COLUMN IF NOT EXISTS school_year_id uuid REFERENCES school_years(school_year_id);
ALTER TABLE planner_teachers          ADD COLUMN IF NOT EXISTS school_year_id uuid REFERENCES school_years(school_year_id);
ALTER TABLE planner_rooms             ADD COLUMN IF NOT EXISTS school_year_id uuid REFERENCES school_years(school_year_id);
ALTER TABLE planner_class_groups      ADD COLUMN IF NOT EXISTS school_year_id uuid REFERENCES school_years(school_year_id);
ALTER TABLE planner_courses           ADD COLUMN IF NOT EXISTS school_year_id uuid REFERENCES school_years(school_year_id);
ALTER TABLE planner_day_templates     ADD COLUMN IF NOT EXISTS school_year_id uuid REFERENCES school_years(school_year_id);
ALTER TABLE planner_fixed_blocks      ADD COLUMN IF NOT EXISTS school_year_id uuid REFERENCES school_years(school_year_id);
ALTER TABLE planner_schedules         ADD COLUMN IF NOT EXISTS school_year_id uuid REFERENCES school_years(school_year_id);
ALTER TABLE planner_schedule_sessions ADD COLUMN IF NOT EXISTS school_year_id uuid REFERENCES school_years(school_year_id);

UPDATE planner_settings          p SET school_year_id = sy.school_year_id FROM school_years sy WHERE sy.school = p.school AND sy.label = '2025-2026' AND p.school_year_id IS NULL;
UPDATE planner_teachers          p SET school_year_id = sy.school_year_id FROM school_years sy WHERE sy.school = p.school AND sy.label = '2025-2026' AND p.school_year_id IS NULL;
UPDATE planner_rooms             p SET school_year_id = sy.school_year_id FROM school_years sy WHERE sy.school = p.school AND sy.label = '2025-2026' AND p.school_year_id IS NULL;
UPDATE planner_class_groups      p SET school_year_id = sy.school_year_id FROM school_years sy WHERE sy.school = p.school AND sy.label = '2025-2026' AND p.school_year_id IS NULL;
UPDATE planner_courses           p SET school_year_id = sy.school_year_id FROM school_years sy WHERE sy.school = p.school AND sy.label = '2025-2026' AND p.school_year_id IS NULL;
UPDATE planner_day_templates     p SET school_year_id = sy.school_year_id FROM school_years sy WHERE sy.school = p.school AND sy.label = '2025-2026' AND p.school_year_id IS NULL;
UPDATE planner_fixed_blocks      p SET school_year_id = sy.school_year_id FROM school_years sy WHERE sy.school = p.school AND sy.label = '2025-2026' AND p.school_year_id IS NULL;
UPDATE planner_schedules         p SET school_year_id = sy.school_year_id FROM school_years sy WHERE sy.school = p.school AND sy.label = '2025-2026' AND p.school_year_id IS NULL;
UPDATE planner_schedule_sessions p SET school_year_id = sy.school_year_id FROM school_years sy WHERE sy.school = p.school AND sy.label = '2025-2026' AND p.school_year_id IS NULL;

ALTER TABLE planner_settings          ALTER COLUMN school_year_id SET NOT NULL;
ALTER TABLE planner_teachers          ALTER COLUMN school_year_id SET NOT NULL;
ALTER TABLE planner_rooms             ALTER COLUMN school_year_id SET NOT NULL;
ALTER TABLE planner_class_groups      ALTER COLUMN school_year_id SET NOT NULL;
ALTER TABLE planner_courses           ALTER COLUMN school_year_id SET NOT NULL;
ALTER TABLE planner_day_templates     ALTER COLUMN school_year_id SET NOT NULL;
ALTER TABLE planner_fixed_blocks      ALTER COLUMN school_year_id SET NOT NULL;
ALTER TABLE planner_schedules         ALTER COLUMN school_year_id SET NOT NULL;
ALTER TABLE planner_schedule_sessions ALTER COLUMN school_year_id SET NOT NULL;

-- one planner config per (school, year) instead of per school
ALTER TABLE planner_settings DROP CONSTRAINT IF EXISTS planner_settings_school_key;
ALTER TABLE planner_settings ADD CONSTRAINT planner_settings_school_year_key UNIQUE (school, school_year_id);

-- one published schedule per (school, year) instead of per school, so
-- publishing a schedule in a new year doesn't collide with (or force-demote)
-- a still-published schedule from an older year.
DROP INDEX IF EXISTS uniq_planner_published_per_school;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_planner_published_per_school_year
  ON planner_schedules(school, school_year_id) WHERE status = 'published';

-- ============ school_calendar_events ============
ALTER TABLE school_calendar_events
  ADD COLUMN IF NOT EXISTS school_year_id uuid REFERENCES school_years(school_year_id);
UPDATE school_calendar_events e SET school_year_id = sy.school_year_id
FROM school_years sy
WHERE sy.school = e.school AND sy.label = '2025-2026' AND e.school_year_id IS NULL;
ALTER TABLE school_calendar_events ALTER COLUMN school_year_id SET NOT NULL;

COMMIT;
