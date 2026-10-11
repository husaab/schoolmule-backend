-- ============================================================
-- Announcements v2: custom audiences (hand-picked students) and opt-in
-- acknowledgements ("Got it").
-- Run in the Supabase SQL editor AFTER announcements_migration.sql.
-- The audience stays derived at read time; announcement_students is the only
-- place a custom selection lives (queries/announcement.queries.js IN_AUDIENCE
-- gains one branch for it). announcement_acks mirrors announcement_reads:
-- per-user state only, a row's existence grants nothing.
-- Safe to re-run: constraints are dropped and re-added, tables use IF NOT EXISTS.
-- ============================================================

BEGIN;

ALTER TABLE announcements DROP CONSTRAINT IF EXISTS announcements_scope_check;
ALTER TABLE announcements ADD CONSTRAINT announcements_scope_check
  CHECK (scope IN ('class','grade','school','custom'));
ALTER TABLE announcements DROP CONSTRAINT IF EXISTS chk_announcements_scope;
ALTER TABLE announcements ADD CONSTRAINT chk_announcements_scope CHECK (
  (scope = 'class'  AND class_id IS NOT NULL) OR
  (scope = 'grade'  AND grade IS NOT NULL) OR
  (scope = 'school') OR
  (scope = 'custom'));
ALTER TABLE announcements ADD COLUMN IF NOT EXISTS ack_requested BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS announcement_students (
  announcement_id  UUID NOT NULL REFERENCES announcements(announcement_id) ON DELETE CASCADE,
  student_id       UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  added_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (announcement_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_announcement_students_student ON announcement_students(student_id);
ALTER TABLE announcement_students ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS announcement_acks (
  announcement_id  UUID NOT NULL REFERENCES announcements(announcement_id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  acked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (announcement_id, user_id)
);
ALTER TABLE announcement_acks ENABLE ROW LEVEL SECURITY;

COMMIT;
