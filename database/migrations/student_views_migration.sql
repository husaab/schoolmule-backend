-- ============================================================
-- Student Views - Custom Filtered Student Lists for Awards & Recognition
-- Run this in Supabase SQL Editor
-- ============================================================
-- Introduces a single table that stores named, savable filter
-- definitions ("views") which the backend evaluates against
-- current grade/attendance data to produce a list of matching
-- students. Two system views are seeded per school.
--
-- Safe to re-run: all DDL uses IF NOT EXISTS / OR REPLACE / DROP
-- and the seed step uses WHERE NOT EXISTS.
-- ============================================================

-- 1. Table
CREATE TABLE IF NOT EXISTS student_views (
  view_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school         school NOT NULL,
  owner_user_id  UUID REFERENCES users(user_id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  is_shared      BOOLEAN NOT NULL DEFAULT FALSE,
  is_system      BOOLEAN NOT NULL DEFAULT FALSE,
  criteria       JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- System views are unowned; user views must have an owner
  CONSTRAINT student_views_owner_or_system_chk CHECK (
    (is_system = TRUE  AND owner_user_id IS NULL)
    OR
    (is_system = FALSE AND owner_user_id IS NOT NULL)
  )
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_student_views_school_owner
  ON student_views(school, owner_user_id);

CREATE INDEX IF NOT EXISTS idx_student_views_school_shared
  ON student_views(school)
  WHERE is_shared = TRUE OR is_system = TRUE;

-- Prevents seeding duplicate system views on re-run
CREATE UNIQUE INDEX IF NOT EXISTS uniq_system_view_school_name
  ON student_views(school, name)
  WHERE is_system = TRUE;

-- 3. RLS (matches the pattern used by other tables — access is mediated
-- by the Node backend's service-role connection)
ALTER TABLE student_views ENABLE ROW LEVEL SECURITY;

-- 4. Trigger: keep updated_at fresh
CREATE OR REPLACE FUNCTION student_views_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_student_views_updated_at ON student_views;
CREATE TRIGGER trg_student_views_updated_at
BEFORE UPDATE ON student_views
FOR EACH ROW
EXECUTE FUNCTION student_views_set_updated_at();

-- 5. Seed two system views per existing school.
-- The "Both Terms" view uses termIdsMode = "FIRST_TWO_TERMS" so it
-- stays school-agnostic — the evaluator resolves it at query time
-- to the two earliest-start_date terms for that school.
INSERT INTO student_views (school, owner_user_id, name, description, is_shared, is_system, criteria)
SELECT
  s.school_value::school,
  NULL,
  v.name,
  v.description,
  TRUE,
  TRUE,
  v.criteria::jsonb
FROM (VALUES
  ('Academic Excellence',
   'Students with an overall average of 85% or higher in the active term.',
   '{"termScope":"active","thresholdPercent":85,"aggregationMode":"overall_avg"}'),
  ('Academic Achievement (Both Terms)',
   'Students with an overall average of 90% or higher in both terms.',
   '{"termScope":"every_listed","termIdsMode":"FIRST_TWO_TERMS","thresholdPercent":90,"aggregationMode":"overall_avg"}')
) AS v(name, description, criteria)
CROSS JOIN (VALUES ('ALHAADIACADEMY'), ('ALRASOOLACADEMY'), ('JCC'), ('PLAYGROUND')) AS s(school_value)
WHERE NOT EXISTS (
  SELECT 1 FROM student_views sv
  WHERE sv.school   = s.school_value::school
    AND sv.name     = v.name
    AND sv.is_system = TRUE
);
