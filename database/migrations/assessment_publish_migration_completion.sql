-- ============================================================
-- Assessment Publishing — completion of a partial migration run
-- Run this in Supabase SQL Editor
-- ============================================================
-- assessment_publish_migration.sql was applied only partially: the columns
-- and tables landed, but the FK, four indexes and — critically — the
-- backfill did not.
--
-- Without the backfill every assessment sits at is_published = FALSE, so
-- the moment the new backend deploys, every parent loses every grade and
-- every child's average reads "—". This script finishes the job.
--
-- Safe to re-run, and safe to run against the already-partial state.
-- ============================================================

BEGIN;

-- 1. FK from assessments.publication_batch_id -> the batches table.
--    (The original DO $$ block did not take.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assessments_publication_batch_id_fkey'
  ) THEN
    ALTER TABLE assessments
      ADD CONSTRAINT assessments_publication_batch_id_fkey
      FOREIGN KEY (publication_batch_id)
      REFERENCES assessment_publication_batches(batch_id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- 2. Missing indexes.
CREATE INDEX IF NOT EXISTS idx_assessments_publication_batch
  ON assessments(publication_batch_id);

CREATE INDEX IF NOT EXISTS idx_assessment_publication_batches_school
  ON assessment_publication_batches(school);

CREATE INDEX IF NOT EXISTS idx_assessment_publication_emails_student
  ON assessment_publication_emails(student_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_weekly_summaries_student_week
  ON ai_weekly_summaries(student_id, week_start);

-- 3. THE BACKFILL — everything that exists today becomes published, so no
--    family loses visibility when the gate goes live. Assessments created
--    after this point default to FALSE, which is the gate working.
--
--    Expect this to report roughly 2026 rows.
UPDATE assessments
SET is_published = TRUE,
    published_at = COALESCE(published_at, created_at, NOW())
WHERE is_published = FALSE;

COMMIT;

-- Verify afterwards — unpublished should be 0:
--   SELECT COUNT(*) FILTER (WHERE is_published)     AS published,
--          COUNT(*) FILTER (WHERE NOT is_published) AS unpublished
--   FROM assessments;
