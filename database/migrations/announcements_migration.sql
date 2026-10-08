-- ============================================================
-- Announcements: one-to-many posts to a class, a grade or the whole school.
-- Run in the Supabase SQL editor AFTER messaging_phase2_migration.sql.
-- Attachments reuse the private bucket `message-attachments` under the
-- prefix <SCHOOL>/announcements/<announcement_id>/ — no new bucket.
-- Audience is derived at read time (class_students / students.grade /
-- parent_students); announcement_reads holds only per-user state.
-- announcement_email_jobs is an outbox drained by services/messageNotifier.js
-- (one row per announcement × guardian email, never coalesced).
-- Safe to re-run: all DDL uses IF NOT EXISTS.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS announcements (
  announcement_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school           school NOT NULL,
  school_year_id   UUID REFERENCES school_years(school_year_id) ON DELETE SET NULL,
  scope            VARCHAR(8) NOT NULL CHECK (scope IN ('class','grade','school')),
  class_id         UUID REFERENCES classes(class_id) ON DELETE CASCADE,
  grade            TEXT,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  author_id        UUID REFERENCES users(user_id) ON DELETE SET NULL,
  author_role      VARCHAR(10) NOT NULL,
  published_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pinned_until     DATE,
  edited_at        TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  deleted_by       UUID REFERENCES users(user_id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_announcements_scope CHECK (
    (scope = 'class'  AND class_id IS NOT NULL) OR
    (scope = 'grade'  AND grade IS NOT NULL) OR
    (scope = 'school'))
);
CREATE INDEX IF NOT EXISTS idx_announcements_school_year ON announcements(school, school_year_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_announcements_class ON announcements(class_id) WHERE class_id IS NOT NULL;
ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS announcement_attachments (
  attachment_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id  UUID NOT NULL REFERENCES announcements(announcement_id) ON DELETE CASCADE,
  file_path        TEXT NOT NULL,
  file_name        TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_announcement_attachments_announcement ON announcement_attachments(announcement_id);
ALTER TABLE announcement_attachments ENABLE ROW LEVEL SECURITY;

-- Per-user state only; a row's existence grants nothing.
CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id  UUID NOT NULL REFERENCES announcements(announcement_id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  read_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (announcement_id, user_id)
);
ALTER TABLE announcement_reads ENABLE ROW LEVEL SECURITY;

-- One row per (announcement, email). recipient_id is NULL for email-only guardians.
CREATE TABLE IF NOT EXISTS announcement_email_jobs (
  job_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id  UUID NOT NULL REFERENCES announcements(announcement_id) ON DELETE CASCADE,
  recipient_id     UUID REFERENCES users(user_id) ON DELETE CASCADE,
  recipient_email  TEXT NOT NULL,
  kind             VARCHAR(8) NOT NULL CHECK (kind IN ('account','invite','signup')),
  school           school NOT NULL,
  send_after       TIMESTAMPTZ NOT NULL,
  status           VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_announcement_email_jobs_recipient
  ON announcement_email_jobs(announcement_id, LOWER(recipient_email));
CREATE INDEX IF NOT EXISTS idx_announcement_email_jobs_due ON announcement_email_jobs(send_after) WHERE status = 'pending';
ALTER TABLE announcement_email_jobs ENABLE ROW LEVEL SECURITY;

COMMIT;
