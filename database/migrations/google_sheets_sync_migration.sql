-- google_sheets_sync_migration.sql
--
-- Keeps a school's Google Sheet current with the submissions on a form, so they
-- stop re-exporting CSVs.
--
-- Three tables:
--   google_connections  one Google account per school, with an encrypted
--                       refresh token. Scope is drive.file only.
--   form_sheet_links    which spreadsheet tab a form writes into, plus the
--                       width of the column block we own. Everything to the
--                       right of that block belongs to the school.
--   sheet_sync_jobs     a durable outbox. A change enqueues a job inside the
--                       caller's transaction, so a write can't be lost to a
--                       crash, and a poller drains it.
--
-- Entirely additive. The feature is inert until a school connects Google.

BEGIN;

CREATE TABLE IF NOT EXISTS google_connections (
  connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school        school NOT NULL UNIQUE,
  google_email  TEXT NOT NULL,
  -- AES-256-GCM ciphertext. Never logged, never returned by the API.
  refresh_token TEXT NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'needs_reconnect')),
  connected_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
  connected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS form_sheet_links (
  link_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One tab per form. UNIQUE is what stops two forms writing over each other.
  form_id          UUID NOT NULL UNIQUE
                   REFERENCES registration_forms(form_id) ON DELETE CASCADE,
  spreadsheet_id   TEXT NOT NULL,
  spreadsheet_name TEXT,
  sheet_tab_id     INTEGER NOT NULL,
  sheet_tab_name   TEXT NOT NULL,
  -- How many leading columns belong to us. Grows when the form gains a field.
  owned_columns    INTEGER NOT NULL DEFAULT 0,
  last_synced_at   TIMESTAMPTZ,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sheet_sync_jobs (
  job_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id         UUID NOT NULL REFERENCES registration_forms(form_id) ON DELETE CASCADE,
  state           VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'running', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Coalescing, enforced by the schema rather than by application logic: at most
-- one live job per form, so a burst of edits produces a single sheet write.
-- enqueueJob relies on this via ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sheet_sync_jobs_live
  ON sheet_sync_jobs (form_id) WHERE state IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS idx_sheet_sync_jobs_ready
  ON sheet_sync_jobs (next_attempt_at) WHERE state = 'pending';

COMMIT;
