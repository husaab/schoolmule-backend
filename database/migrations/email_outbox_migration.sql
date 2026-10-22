-- ============================================================
-- One outbox for outgoing email (services/email/outbox.js).
--
-- A feature writes one row per recipient address inside its own
-- transaction (so a saved change can never lose its email), and the
-- notifier's 30-second tick sends due rows: claimed with FOR UPDATE SKIP
-- LOCKED and a 5-minute lease, built from the database as it is at send
-- time (payload holds ids only), sent once through Resend with an
-- idempotency key, then marked sent / skipped / failed.
--
-- First kind: 'grades_digest', the parents' "New Grades Posted" email,
-- which the publish request used to send itself. The other email queues
-- (message_email_jobs, announcement_email_jobs, classroom_email_jobs) can
-- move here later.
--
-- Additive only: one new table nothing on main reads or writes yet. Apply
-- BEFORE the backend that writes it (a publish enqueues inside its
-- transaction, so without this table every publish would fail). Safe to
-- re-run.
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS email_outbox (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                TEXT NOT NULL,
  school              school NOT NULL,
  recipient_user_id   UUID REFERENCES users(user_id) ON DELETE SET NULL,
  -- One row per address. NULL only on a 'skipped' row that records there
  -- was nobody to email (a student with no guardian address on file).
  recipient_email     TEXT,
  -- What the email is about: 'publish_batch' + assessment_publication_batches.batch_id, …
  subject_type        TEXT NOT NULL,
  subject_id          UUID,
  class_id            UUID REFERENCES classes(class_id) ON DELETE CASCADE,
  student_id          UUID REFERENCES students(student_id) ON DELETE CASCADE,
  -- The same (kind, address, dedupe_key) is queued once.
  dedupe_key          TEXT NOT NULL,
  -- Pending rows for one address sharing this key go out as one email.
  coalesce_key        TEXT,
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,   -- ids only; content is read at send time
  priority            SMALLINT NOT NULL DEFAULT 5,          -- lower goes first
  send_after          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts            INT NOT NULL DEFAULT 0,
  -- Definite refusals and manual retries; part of the Resend idempotency key.
  error_count         INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  skip_reason         TEXT,
  merged_into         UUID REFERENCES email_outbox(id) ON DELETE SET NULL,
  provider_message_id TEXT,
  sent_content        JSONB,                                -- a short summary of what was sent
  created_by          UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at         TIMESTAMPTZ,
  CONSTRAINT email_outbox_recipient_ck CHECK (recipient_email IS NOT NULL OR status = 'skipped')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_outbox_dedupe
  ON email_outbox (kind, LOWER(COALESCE(recipient_email, '')), dedupe_key);
CREATE INDEX IF NOT EXISTS idx_email_outbox_due
  ON email_outbox (priority, send_after) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_email_outbox_coalesce
  ON email_outbox (kind, LOWER(recipient_email), coalesce_key) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_email_outbox_subject
  ON email_outbox (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_email_outbox_class
  ON email_outbox (class_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_outbox_student
  ON email_outbox (student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_outbox_school
  ON email_outbox (school, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_outbox_recipient_user
  ON email_outbox (recipient_user_id) WHERE recipient_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_outbox_created_by
  ON email_outbox (created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_outbox_merged_into
  ON email_outbox (merged_into) WHERE merged_into IS NOT NULL;

ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;

COMMIT;
