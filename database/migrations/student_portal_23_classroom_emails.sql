-- ============================================================
-- Student portal, phase 2 (Task 21): class emails to students and the
-- parents' weekly summary / missing-work alert, through one outbox drained
-- by services/messageNotifier.js. One row per recipient address per digest
-- key: the unique index is what makes a worker tick, a restart or a second
-- instance re-running an enqueue harmless (ON CONFLICT DO NOTHING).
--
-- notification_prefs: a parent's email choices. No row = the defaults
-- (weekly summary on the school's day, missing-work alerts on).
--
-- Controller applies after review. Additive only: two new tables that the
-- code on main never reads or writes, no change to any existing object, so
-- no CHECK needs widening. Safe to re-run.
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id            UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  weekly_summary     BOOLEAN NOT NULL DEFAULT TRUE,
  summary_frequency  TEXT NOT NULL DEFAULT 'weekly' CHECK (summary_frequency IN ('weekly', 'daily')),
  summary_dow        SMALLINT CHECK (summary_dow BETWEEN 0 AND 6),   -- NULL = the school's day
  missing_alerts     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE notification_prefs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS classroom_email_jobs (
  job_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT NOT NULL CHECK (kind IN ('new_work', 'due_reminder', 'graded', 'missing_alert', 'weekly_summary')),
  digest_key       TEXT NOT NULL,
  recipient_id     UUID REFERENCES users(user_id) ON DELETE CASCADE,
  recipient_email  TEXT NOT NULL,
  school           school NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- ids and dates only; content is read at send time
  send_after       TIMESTAMPTZ NOT NULL,
  status           VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts         INT NOT NULL DEFAULT 0,
  last_error       TEXT,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_classroom_email_jobs_digest ON classroom_email_jobs (LOWER(recipient_email), kind, digest_key);
CREATE INDEX IF NOT EXISTS idx_classroom_email_jobs_due ON classroom_email_jobs (send_after) WHERE status = 'pending';
ALTER TABLE classroom_email_jobs ENABLE ROW LEVEL SECURITY;

COMMIT;
