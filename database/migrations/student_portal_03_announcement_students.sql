-- ============================================================
-- Student portal, phase 1: students receive class announcements by email.
--
-- 1. announcement_email_jobs.kind gains 'student' (the student's own login
--    address; gated by school_classroom_settings.student_email_from_grade).
--    The CHECK is widened by dropping and re-adding the same constraint name
--    with a superset of values. The original inline CHECK in
--    announcements_migration.sql is auto-named announcement_email_jobs_kind_check.
-- 2. announcements.send_email: the author may post without emailing anyone.
--    Defaults to TRUE, so code on main (which never sets it) keeps emailing.
--
-- Additive and backward compatible with the code on main. Safe to re-run.
-- Apply BEFORE deploying the backend that enqueues 'student' jobs.
-- ============================================================
BEGIN;

ALTER TABLE announcement_email_jobs DROP CONSTRAINT IF EXISTS announcement_email_jobs_kind_check;
ALTER TABLE announcement_email_jobs ADD CONSTRAINT announcement_email_jobs_kind_check
  CHECK (kind IN ('account', 'invite', 'signup', 'student'));

ALTER TABLE announcements ADD COLUMN IF NOT EXISTS send_email BOOLEAN NOT NULL DEFAULT TRUE;

COMMIT;
