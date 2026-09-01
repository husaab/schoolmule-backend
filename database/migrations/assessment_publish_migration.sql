-- ============================================================
-- Publish Assessments to Parents
-- Run this in Supabase SQL Editor
-- ============================================================
-- Adds a hard publish gate to `assessments`: parents only ever see
-- published work, and unpublished work is excluded from the parent-facing
-- average entirely (see services/analyticsEngine.js buildAnalyticsMatrix,
-- publishedOnly option). Teacher analytics, the admin dashboard and report
-- cards are unaffected — they never pass publishedOnly.
--
-- Every assessment that exists TODAY is backfilled as published, so no
-- family loses visibility on day one. Assessments created after this
-- migration default to unpublished — that is the gate.
--
-- Also adds:
--   - assessment_publication_batches: one row per publish/unpublish action
--     (batch comment + audit trail).
--   - assessment_publication_emails: per-recipient send log, modelled on
--     student_view_emails. Unlike that table, a row's existence does NOT
--     mean "sent" — see the status column. Email failures must never roll
--     back or fail the publish itself.
--   - ai_weekly_summaries: cache for the parent dashboard's AI weekly
--     summary, one row per (student, week). Generated on demand, deleted
--     when new marks are published mid-week.
--   - parent_students.last_seen_at: drives the "NEW" badge on the parent
--     dashboard's recently-published feed.
--
-- Safe to re-run: all DDL uses IF NOT EXISTS / conditional constraint adds,
-- and the backfill only touches rows still at the default.
-- ============================================================

BEGIN;

-- ────────────────────────────────────────────────────────────
-- 1. Publish state on assessments
-- ────────────────────────────────────────────────────────────
ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS published_by UUID REFERENCES users(user_id);

-- Which batch most recently changed this row's publish state. Set on
-- publish AND on unpublish, so the class history endpoint can answer
-- "who pulled this back, and when?". FK wired up in step 2, once the
-- batches table exists.
ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS publication_batch_id UUID;

-- Teacher's note about this assessment, shown to parents in the grade
-- breakdown. One per assessment (not per student), and it survives
-- unpublish/republish so a rollback doesn't lose the text.
ALTER TABLE assessments
  ADD COLUMN IF NOT EXISTS parent_comment TEXT;

CREATE INDEX IF NOT EXISTS idx_assessments_class_published
  ON assessments(class_id, is_published);

-- ────────────────────────────────────────────────────────────
-- 2. Publication batches — one row per publish/unpublish action
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assessment_publication_batches (
  batch_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id              UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
  school                school NOT NULL,
  action                VARCHAR(10) NOT NULL CHECK (action IN ('publish', 'unpublish')),
  assessment_ids        UUID[] NOT NULL,        -- final set, after cascade expansion
  batch_comment         TEXT,                   -- email body block; publish only
  triggered_by          UUID REFERENCES users(user_id),
  student_warning_count INTEGER NOT NULL DEFAULT 0,  -- ungraded students at action time
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assessment_publication_batches_class
  ON assessment_publication_batches(class_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_assessment_publication_batches_school
  ON assessment_publication_batches(school);

ALTER TABLE assessment_publication_batches ENABLE ROW LEVEL SECURITY;

-- Now that the batches table exists, wire up the FK from assessments.
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

CREATE INDEX IF NOT EXISTS idx_assessments_publication_batch
  ON assessments(publication_batch_id);

-- ────────────────────────────────────────────────────────────
-- 3. Email audit log (modelled on student_view_emails)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS assessment_publication_emails (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL REFERENCES assessment_publication_batches(batch_id) ON DELETE CASCADE,
  student_id      UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  sent_by         UUID REFERENCES users(user_id),
  email_addresses JSONB NOT NULL,               -- ["mom@x.com","dad@x.com"]; [] when skipped
  assessment_ids  UUID[] NOT NULL,              -- subset this student actually had a score for
  school          school NOT NULL,
  status          VARCHAR(10) NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('sent', 'failed', 'skipped')),
  error_message   TEXT,                         -- set when status = 'failed'
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assessment_publication_emails_batch
  ON assessment_publication_emails(batch_id);

CREATE INDEX IF NOT EXISTS idx_assessment_publication_emails_student
  ON assessment_publication_emails(student_id, sent_at DESC);

ALTER TABLE assessment_publication_emails ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────
-- 4. AI weekly summary cache
-- ────────────────────────────────────────────────────────────
-- One row per (student, week). Written on first dashboard view that week,
-- deleted when new marks are published mid-week so the next view
-- regenerates. model = 'none' means the no-activity canned line (no
-- OpenAI call was made).
CREATE TABLE IF NOT EXISTS ai_weekly_summaries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  week_start   DATE NOT NULL,
  content      TEXT NOT NULL,
  model        TEXT NOT NULL DEFAULT 'gpt-4o-mini',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_ai_weekly_summaries_student_week
  ON ai_weekly_summaries(student_id, week_start);

ALTER TABLE ai_weekly_summaries ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────
-- 5. "NEW" badge tracking for the parent dashboard feed
-- ────────────────────────────────────────────────────────────
-- NULL means the parent has never opened the dashboard, in which case
-- everything published counts as new.
ALTER TABLE parent_students
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- ────────────────────────────────────────────────────────────
-- 6. Backfill — everything that exists today is published
-- ────────────────────────────────────────────────────────────
-- Rows inserted after this migration get the DEFAULT FALSE from step 1,
-- which is the gate. Verify: the row count reported here should equal the
-- pre-migration assessments row count.
UPDATE assessments
SET is_published = TRUE,
    published_at = COALESCE(published_at, created_at, NOW())
WHERE is_published = FALSE;

COMMIT;
