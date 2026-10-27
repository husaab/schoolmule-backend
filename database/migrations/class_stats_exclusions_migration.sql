-- ============================================================
-- Class statistics exclusions (2026-10-27).
--
-- A teacher leaves a student out of a class's pooled statistics: the class
-- average, median, distribution, rank and percentile, and the per-assessment
-- class averages. The student's own marks and term grade never change.
--
--   assessment_id NULL      left out of the whole class
--   assessment_id = column  left out of that column's class average only
--                           (a category also covers its children)
--
-- The composite FK ties a row to the enrolment, so unenrolling removes it.
-- The two partial unique indexes keep at most one whole-class row and one row
-- per column for a student, which the analytics matrix LEFT JOINs rely on.
-- Additive only; safe to re-run. Apply before the backend that reads it: the
-- analytics matrix queries join this table.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS class_stats_exclusions (
  exclusion_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id      UUID NOT NULL,
  student_id    UUID NOT NULL,
  assessment_id UUID REFERENCES assessments(assessment_id) ON DELETE CASCADE,
  note          TEXT,
  created_by    UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (class_id, student_id) REFERENCES class_students(class_id, student_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS class_stats_exclusions_whole_class
  ON class_stats_exclusions (class_id, student_id) WHERE assessment_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS class_stats_exclusions_per_assessment
  ON class_stats_exclusions (class_id, student_id, assessment_id) WHERE assessment_id IS NOT NULL;

-- Like every table here: RLS on with no policies, so only the backend's own
-- role reads it and Supabase's public API can't.
ALTER TABLE class_stats_exclusions ENABLE ROW LEVEL SECURITY;

COMMIT;
