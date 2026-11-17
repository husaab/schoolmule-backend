-- Salaat on the grades 1-8 progress report (Al Haadi asked, 2026-11-16).
--
-- A school that turns it on gets a "Salaat" box after the subject cards:
-- Work Habits and Behaviour (E/G/S/N) and a comment, filled in by the
-- student's homeroom teacher. One row per student per term; the student row
-- belongs to one school year, so (student_id, term) is unique per year.
--
-- DEPLOY: run this before the backend that reads it.

BEGIN;

ALTER TABLE schools
  ADD COLUMN IF NOT EXISTS progress_salaat BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS progress_report_salaat (
  student_id  UUID NOT NULL REFERENCES students_all(student_id) ON DELETE CASCADE,
  term        TEXT NOT NULL,
  work_habit  TEXT CHECK (work_habit IN ('E', 'G', 'S', 'N')),
  behavior    TEXT CHECK (behavior IN ('E', 'G', 'S', 'N')),
  comment     TEXT,
  updated_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (student_id, term)
);

UPDATE schools SET progress_salaat = TRUE WHERE school_code::text = 'ALHAADIACADEMY';

COMMIT;
