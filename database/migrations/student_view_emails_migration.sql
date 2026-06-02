-- ============================================================
-- Student View Emails - Certificate-to-Parent send log
-- Run this in Supabase SQL Editor
-- ============================================================
-- Logs every award certificate emailed to a parent from a
-- Student View (one row per student per send). Mirrors the
-- report_emails audit pattern but drops report-specific columns
-- (term, file_path — certificates are generated in-memory, not
-- stored) and adds view_id + a metric snapshot.
--
-- A row's existence means "sent" (same convention as
-- report_emails — there is no status/message_id column today).
--
-- Safe to re-run: all DDL uses IF NOT EXISTS / OR REPLACE / DROP.
-- ============================================================

-- 1. Table
CREATE TABLE IF NOT EXISTS student_view_emails (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  view_id         UUID NOT NULL REFERENCES student_views(view_id) ON DELETE CASCADE,
  student_id      UUID NOT NULL REFERENCES students(student_id),
  sent_by         UUID REFERENCES users(user_id),
  email_addresses JSONB NOT NULL,                 -- ["mom@x.com","dad@x.com"]
  cc_addresses    JSONB,                          -- nullable
  custom_header   TEXT,                           -- subject (shared across the batch)
  custom_message  TEXT,                           -- body block (shared across the batch)
  metric          NUMERIC,                        -- displayMetric snapshot at send time
  school          school NOT NULL,                -- existing school enum
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_student_view_emails_view
  ON student_view_emails(view_id);

CREATE INDEX IF NOT EXISTS idx_student_view_emails_student
  ON student_view_emails(student_id);

-- 3. RLS (matches the pattern used by student_views and other tables —
-- access is mediated by the Node backend's service-role connection)
ALTER TABLE student_view_emails ENABLE ROW LEVEL SECURITY;
