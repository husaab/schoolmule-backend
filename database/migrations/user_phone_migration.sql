-- ============================================================
-- Phone numbers on accounts (2026-11-23).
--
-- users.phone: anyone's own number, optional. Staff add theirs in Settings
-- (or the office in Admin → Users); parent–teacher meetings show a teacher's
-- number to the families who booked a phone call with them, and fill in a
-- parent's number when they book one.
-- ptm_teachers.call_from: a teacher's "Number I'll call from" for one set
-- of meetings, when it isn't the number on their account.
--
-- Additive only. Apply BEFORE the backend that reads users.phone. Safe to
-- re-run.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE ptm_teachers ADD COLUMN IF NOT EXISTS call_from TEXT;

DO $$
BEGIN
  ALTER TABLE users ADD CONSTRAINT users_phone_ck CHECK (phone IS NULL OR length(phone) BETWEEN 7 AND 40);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE ptm_teachers ADD CONSTRAINT ptm_teachers_call_from_ck CHECK (call_from IS NULL OR length(call_from) BETWEEN 7 AND 40);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
