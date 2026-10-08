-- ============================================================
-- Parent–teacher messaging (phase 1)
-- Run this in Supabase SQL Editor. Then create a PRIVATE storage bucket
-- named `message-attachments` (no bucket-level limits; the backend enforces
-- type, size and count).
-- ============================================================
-- A conversation is about one student in one class, optionally anchored to
-- one assessment (phase 1 always anchors; NULL is reserved for phase 2).
-- Membership is NOT stored: it is resolved at request time from
-- parent_students, classes.teacher_id and class_teachers, so a guardian
-- linked after the thread began sees it. conversation_participants holds
-- only per-user state (read / emailed / muted).
--
-- message_email_jobs is an outbox: one pending row per (conversation,
-- recipient) collapses a burst of replies into one email. Drained by
-- services/messageNotifier.js.
--
-- Safe to re-run: all DDL uses IF NOT EXISTS.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school           school NOT NULL,
  student_id       UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  class_id         UUID NOT NULL REFERENCES classes(class_id) ON DELETE CASCADE,
  assessment_id    UUID REFERENCES assessments(assessment_id) ON DELETE SET NULL,
  title            TEXT NOT NULL,                 -- snapshot of the assessment name
  status           VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_by       UUID REFERENCES users(user_id),
  resolved_by      UUID REFERENCES users(user_id),
  resolved_at      TIMESTAMPTZ,
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_anchor
  ON conversations(student_id, class_id, assessment_id) WHERE assessment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_class   ON conversations(class_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_student ON conversations(student_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_school  ON conversations(school, last_message_at DESC);
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS messages (
  message_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  sender_id        UUID REFERENCES users(user_id) ON DELETE SET NULL,
  sender_role      VARCHAR(10) NOT NULL,          -- PARENT | TEACHER | ADMIN, snapshot
  kind             VARCHAR(10) NOT NULL DEFAULT 'message' CHECK (kind IN ('message','system')),
  body             TEXT NOT NULL,                 -- plain text; system lines are English text
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at        TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  deleted_by       UUID REFERENCES users(user_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS message_attachments (
  attachment_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id       UUID NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  file_path        TEXT NOT NULL,                 -- <SCHOOL>/<conversation_id>/<message_id>/<uuid>.<ext>
  file_name        TEXT NOT NULL,                 -- original name, for display
  mime_type        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id);
ALTER TABLE message_attachments ENABLE ROW LEVEL SECURITY;

-- Per-user state only; a row's existence grants nothing.
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id  UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  last_read_at     TIMESTAMPTZ,
  last_emailed_at  TIMESTAMPTZ,
  muted            BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (conversation_id, user_id)
);
ALTER TABLE conversation_participants ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS message_email_jobs (
  job_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  recipient_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  school           school NOT NULL,
  send_after       TIMESTAMPTZ NOT NULL,
  status           VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','skipped','failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_message_email_jobs_pending
  ON message_email_jobs(conversation_id, recipient_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_message_email_jobs_due ON message_email_jobs(send_after) WHERE status = 'pending';
ALTER TABLE message_email_jobs ENABLE ROW LEVEL SECURITY;

COMMIT;
