-- ============================================================
-- Reply reminders (2026-10-23): two school switches.
--
-- reply_reminders: a parent wrote and nobody at school has replied at all.
--   The teacher is reminded on school day 2 and again two school days later;
--   the school day after that, everyone with All messages access is told.
-- parent_nudge: a teacher wrote and nobody in the family has replied at all.
--   Each guardian is emailed once, after 2 school days.
--
-- Off by default; an admin turns them on in School Settings → Classroom &
-- parent emails. Progress lives in email_outbox (kinds reply_reminder,
-- reply_escalation, reply_nudge), so there is no table of its own.
-- Additive only; safe to re-run. Apply before the backend that reads them.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE school_classroom_settings ADD COLUMN IF NOT EXISTS reply_reminders BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE school_classroom_settings ADD COLUMN IF NOT EXISTS parent_nudge BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
