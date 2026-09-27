-- user_archive_migration.sql
--
-- Archive (soft-delete) for staff and other accounts. An archived user keeps
-- every row that points at them (classes, attendance history, report emails)
-- but disappears from staff lists, teacher pickers and the dashboard count,
-- and cannot sign in. Deleting a teacher would cascade through
-- classes.teacher_id and wipe their classes, so archive is the safe path.
--
-- Entirely additive and safe to re-run. A backend deployed before this
-- migration never reads the new columns.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES users(user_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_school_active_idx ON users (school) WHERE is_archived = FALSE;

COMMIT;
