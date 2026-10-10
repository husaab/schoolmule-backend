-- ============================================================================
-- Grading status migration (non-zero grading)
--
-- Purpose: give every score cell an explicit status so the grade engine can
-- tell "not yet graded" (no evidence, no weight) apart from "missing"
-- (deliberate, counts as 0) and "excused" (never counts). This replaces the
-- student_excluded_assessments table as the source of truth for exemptions.
--
-- Run this in the Supabase SQL Editor BEFORE deploying the backend that
-- reads student_assessments.status. Safe to re-run (idempotent). The old
-- code ignores the new column, so it is safe to run ahead of the deploy.
--
-- Backfill rules (decision D3, 2026-10-10):
--   * an exclusion on a cell that HAS a score            -> status = 'excused'
--   * an exclusion on a category -> each child WITH a score -> 'excused'
--   * an exclusion on a blank cell                        -> nothing; a blank
--     already carries no weight under the new engine, and an "Excused" pill
--     on 3,400 cells that were only ever "not graded yet" would mislead.
-- student_excluded_assessments is left in place (no longer read) so the
-- backfill can be audited; drop it in a later cleanup once verified.
-- ============================================================================

BEGIN;

ALTER TABLE student_assessments
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'graded';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'student_assessments_status_check'
  ) THEN
    ALTER TABLE student_assessments
      ADD CONSTRAINT student_assessments_status_check
      CHECK (status IN ('graded', 'missing', 'excused'));
  END IF;
END $$;

-- 1) Leaf-level exclusions on cells that have an entered score.
UPDATE student_assessments sa
SET status = 'excused'
FROM student_excluded_assessments x
JOIN assessments a ON a.assessment_id = x.assessment_id AND a.is_parent = FALSE
WHERE sa.student_id = x.student_id
  AND sa.assessment_id = x.assessment_id
  AND sa.score IS NOT NULL
  AND sa.status = 'graded';

-- 2) Category-level exclusions: excuse each child that has an entered score.
UPDATE student_assessments sa
SET status = 'excused'
FROM student_excluded_assessments x
JOIN assessments p ON p.assessment_id = x.assessment_id AND p.is_parent = TRUE
JOIN assessments c ON c.parent_assessment_id = p.assessment_id
WHERE sa.student_id = x.student_id
  AND sa.assessment_id = c.assessment_id
  AND sa.score IS NOT NULL
  AND sa.status = 'graded';

COMMIT;
