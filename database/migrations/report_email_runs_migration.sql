-- ============================================================
-- Report card and progress report emails through the email outbox.
--
-- A "Send" (one student or many) is a report_email_runs row: what was sent
-- (type, term, subject, message, CC) and by whom. Each email of it is an
-- email_outbox row (kind 'report_email', subject 'report_email_run'), sent
-- by the notifier's tick with the PDF attached; the page shows progress
-- from those rows. A sent email is still logged in report_emails, now with
-- its run, one row per student per run.
--
-- Additive only: a new table and a nullable column the code on main never
-- reads. Requires email_outbox_migration.sql. Apply BEFORE the backend that
-- writes it. Safe to re-run.
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS report_email_runs (
  run_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school          school NOT NULL,
  report_type     TEXT NOT NULL CHECK (report_type IN ('progress_report', 'report_card')),
  term            TEXT NOT NULL,
  custom_header   TEXT,
  custom_message  TEXT,
  cc_addresses    JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 'guardians': each student's parents on file (bulk), re-checked when sent;
  -- 'chosen': the addresses the sender typed (one student).
  recipients      TEXT NOT NULL DEFAULT 'guardians' CHECK (recipients IN ('guardians', 'chosen')),
  student_count   INT NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_email_runs_school
  ON report_email_runs (school, report_type, term, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_email_runs_created_by
  ON report_email_runs (created_by) WHERE created_by IS NOT NULL;
ALTER TABLE report_email_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE report_emails ADD COLUMN IF NOT EXISTS run_id UUID REFERENCES report_email_runs(run_id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_report_emails_run_student
  ON report_emails (run_id, student_id) WHERE run_id IS NOT NULL;

COMMIT;
