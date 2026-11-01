-- ============================================================
-- The principal and board a school's report cards print
-- ({{school.principal}} / {{school.board}} in reportkit templates), edited in
-- School Settings → School Information. Ontario report cards carry a
-- "Board:" line: the school board's name, or "Private" for a private school.
--
-- DEPLOY ORDER: 1) this migration  2) backend  3) frontend. The report data
-- assembler selects these columns.
--
-- Additive only and safe to re-run.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE schools ADD COLUMN IF NOT EXISTS principal_name TEXT;
ALTER TABLE schools ADD COLUMN IF NOT EXISTS board_name TEXT;

-- Al Haadi's kindergarten report cards used to hard-code these.
UPDATE schools SET principal_name = 'Majida Saab'
  WHERE school_code::text = 'ALHAADIACADEMY' AND principal_name IS NULL;
UPDATE schools SET board_name = 'Private'
  WHERE school_code::text = 'ALHAADIACADEMY' AND board_name IS NULL;

COMMIT;
