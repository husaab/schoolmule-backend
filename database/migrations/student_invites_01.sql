-- ============================================================
-- Student invitations: one row per invite email (hashed one-time link, its
-- send outcome and how it ended), the account's activation and session
-- revocation stamps, and the school's student email domains and sign-in
-- mode. Additive only; main's code never reads any of it. Safe to re-run.
-- Apply after the student_portal_* migrations.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS student_invites (
  invite_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school               school NOT NULL,
  -- SET NULL, not CASCADE: cancelling an unused invite deletes its login,
  -- and the row must survive so the old link can still say "cancelled".
  user_id              UUID REFERENCES users(user_id) ON DELETE SET NULL,
  student_id           UUID NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  school_year_id       UUID NOT NULL REFERENCES school_years(school_year_id) ON DELETE CASCADE,
  -- The address it went to (lowercased snapshot).
  email                TEXT NOT NULL,
  -- SHA-256 hex of the link's secret; kept after the invite ends so a dead
  -- link can still say why it is dead. The secret itself is never stored.
  token_hash           TEXT NOT NULL UNIQUE,
  expires_at           TIMESTAMPTZ NOT NULL,
  created_by           UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  send_status          TEXT NOT NULL DEFAULT 'pending' CHECK (send_status IN ('pending','sent','failed')),
  sent_at              TIMESTAMPTZ,
  send_error           TEXT,
  -- Resend's id for the email, for bounce tracking later.
  provider_message_id  TEXT,
  ended_at             TIMESTAMPTZ,
  end_reason           TEXT CHECK (end_reason IN ('accepted','replaced','cancelled','email_changed','archived')),
  ended_by             UUID REFERENCES users(user_id) ON DELETE SET NULL,
  accepted_via         TEXT CHECK (accepted_via IN ('password','google'))
);
-- At most one open invite per login.
CREATE UNIQUE INDEX IF NOT EXISTS uq_student_invites_open ON student_invites (user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_student_invites_student ON student_invites (student_id, created_at DESC);
ALTER TABLE student_invites ENABLE ROW LEVEL SECURITY;

-- First sign-in by any method (password, Google or the QR card).
ALTER TABLE student_accounts ADD COLUMN IF NOT EXISTS activated_at  TIMESTAMPTZ;
ALTER TABLE student_accounts ADD COLUMN IF NOT EXISTS activated_via TEXT
  CHECK (activated_via IS NULL OR activated_via IN ('password','google','card'));
-- Sessions issued at or before this instant are refused (a changed address).
ALTER TABLE student_accounts ADD COLUMN IF NOT EXISTS sessions_revoked_at TIMESTAMPTZ;
-- The guardian "account ready" email goes once per login, ever.
ALTER TABLE student_accounts ADD COLUMN IF NOT EXISTS guardians_notified_at TIMESTAMPTZ;

ALTER TABLE school_classroom_settings ADD COLUMN IF NOT EXISTS student_email_domains TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE school_classroom_settings ADD COLUMN IF NOT EXISTS student_sign_in TEXT NOT NULL DEFAULT 'google_or_password'
  CHECK (student_sign_in IN ('google_or_password','google_only'));

COMMIT;
