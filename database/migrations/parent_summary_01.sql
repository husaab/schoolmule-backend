-- ============================================================
-- The parents' weekly summary gets its own switch, apart from the student
-- portal (school_classroom_settings.enabled): a school can send parents the
-- summary with student sign-in off. Off by default; an admin turns it on in
-- the school's settings. Additive only; code on main never reads it. Safe
-- to re-run.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE school_classroom_settings ADD COLUMN IF NOT EXISTS parent_summary BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
