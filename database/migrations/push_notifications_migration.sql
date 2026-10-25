-- push_notifications_migration.sql
--
-- Push notifications for the mobile app (services/push).
--
--   push_devices      one row per installed app that allowed notifications:
--                     its Expo push token and the account signed in on it.
--                     The token is the key, so a phone that changes hands
--                     moves to the account that signed in last.
--   push_preferences  a person's per-category switches. No row = all on.
--   push_jobs         the queue: one row per notification for one person,
--                     content written when the event happened, sent by the
--                     notifier's tick (or at once, for messages).
--   push_tickets      Expo's receipt ids for the ~15-minute delivery check;
--                     a receipt saying the app is gone deletes the device.
--
-- Entirely additive and safe to re-run. Apply BEFORE the backend that writes
-- it (the queue stands down with one log line while the tables are missing).

BEGIN;

CREATE TABLE IF NOT EXISTS push_devices (
  token        TEXT PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  platform     TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS push_devices_user_idx ON push_devices (user_id);

CREATE TABLE IF NOT EXISTS push_preferences (
  user_id       UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  messages      BOOLEAN NOT NULL DEFAULT TRUE,
  announcements BOOLEAN NOT NULL DEFAULT TRUE,
  grades        BOOLEAN NOT NULL DEFAULT TRUE,
  classwork     BOOLEAN NOT NULL DEFAULT TRUE,
  reminders     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS push_jobs (
  job_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('messages', 'announcements', 'grades', 'classwork', 'reminders')),
  recipient_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  -- One notification per (kind, person, key): a re-run adds nothing, and a
  -- pending row absorbs repeats (`merged` counts them).
  dedupe_key   TEXT NOT NULL,
  title        TEXT NOT NULL,
  subtitle     TEXT,
  body         TEXT NOT NULL,
  -- The app screen a tap opens: the same path the email links to.
  path         TEXT NOT NULL,
  thread_key   TEXT,
  merged       INT NOT NULL DEFAULT 1,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  send_after   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS push_jobs_dedupe_key ON push_jobs (kind, recipient_id, dedupe_key);
CREATE INDEX IF NOT EXISTS push_jobs_due_idx ON push_jobs (send_after) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS push_jobs_created_idx ON push_jobs (created_at);

CREATE TABLE IF NOT EXISTS push_tickets (
  ticket_id  TEXT PRIMARY KEY,
  token      TEXT NOT NULL REFERENCES push_devices(token) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS push_tickets_created_idx ON push_tickets (created_at);

-- The backend's service connection bypasses RLS; nothing else may read these.
ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_tickets ENABLE ROW LEVEL SECURITY;

COMMIT;
