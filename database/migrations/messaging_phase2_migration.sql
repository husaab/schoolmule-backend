-- ============================================================
-- Messaging phase 2: general conversations + guardian invites
-- Run after messaging_migration.sql. Safe to re-run.
-- ============================================================
-- A conversation may now be anchored to a student and a teacher with no
-- assessment ("general"), and to a homeroom teacher with no class row.
-- Guardian invites reuse the admin invite mechanism (invite-pending user,
-- password sentinel '!', password_reset_tokens); the bookkeeping lives on
-- the parent_students link row next to the email the invite went to.
-- ============================================================

BEGIN;

ALTER TABLE conversations ALTER COLUMN class_id DROP NOT NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS teacher_id UUID REFERENCES users(user_id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS kind VARCHAR(12) NOT NULL DEFAULT 'assessment'
  CHECK (kind IN ('assessment','general'));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_conversations_anchor') THEN
    ALTER TABLE conversations ADD CONSTRAINT chk_conversations_anchor
      CHECK (class_id IS NOT NULL OR teacher_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_teacher
  ON conversations(teacher_id, last_message_at DESC) WHERE teacher_id IS NOT NULL;

ALTER TABLE parent_students ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;
ALTER TABLE parent_students ADD COLUMN IF NOT EXISTS invite_reminded_at TIMESTAMPTZ;
ALTER TABLE parent_students ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES users(user_id) ON DELETE SET NULL;
ALTER TABLE parent_students ADD COLUMN IF NOT EXISTS invite_conversation_id UUID REFERENCES conversations(conversation_id) ON DELETE SET NULL;

COMMIT;
