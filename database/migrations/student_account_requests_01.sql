-- ============================================================
-- Student account requests: a student asks for an account from the public
-- signup page (/signup/<school>/student); the office approves it on the
-- Approvals page by matching it to the student's existing record, which sends
-- the normal student invite. A request is never a login: nothing exists until
-- an admin approves it. Requests are taken at every school, whatever its
-- classroom settings.
--
-- Additive only and safe to re-run. Apply after student_invites_01.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS student_account_requests (
  request_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school       school NOT NULL,
  first_name   TEXT NOT NULL CHECK (char_length(first_name) BETWEEN 1 AND 60),
  last_name    TEXT NOT NULL CHECK (char_length(last_name) BETWEEN 1 AND 60),
  -- As the student typed it: a hint for matching, never a filter.
  grade        TEXT NOT NULL CHECK (grade IN ('JK','SK','1','2','3','4','5','6','7','8')),
  -- Typed by the student, not verified; the invite proves the mailbox.
  email        TEXT NOT NULL CHECK (email = lower(email) AND char_length(email) <= 254),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at   TIMESTAMPTZ,
  decided_by   UUID REFERENCES users(user_id) ON DELETE SET NULL,
  -- The record the admin matched and the login approval created. SET NULL:
  -- deleting either must not delete the request's history.
  student_id   UUID REFERENCES students(student_id) ON DELETE SET NULL,
  user_id      UUID REFERENCES users(user_id) ON DELETE SET NULL,
  CONSTRAINT student_account_requests_decided_ck CHECK ((status = 'pending') = (decided_at IS NULL))
);
-- One pending request per address per school.
CREATE UNIQUE INDEX IF NOT EXISTS uq_student_account_requests_pending
  ON student_account_requests (school, lower(email)) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_student_account_requests_school
  ON student_account_requests (school, status, created_at DESC);
ALTER TABLE student_account_requests ENABLE ROW LEVEL SECURITY;

-- When the school's admins were last emailed about new requests (at most
-- one email an hour per school, claimed atomically).
ALTER TABLE schools ADD COLUMN IF NOT EXISTS student_requests_notified_at TIMESTAMPTZ;

COMMIT;
