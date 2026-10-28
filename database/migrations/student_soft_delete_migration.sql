-- Student soft delete (2026-10-28). "Delete" no longer removes a student's
-- rows: the student is marked deleted and disappears everywhere (lists,
-- rosters, reports, portals, message threads), while grades, attendance and
-- report cards stay. Admins restore from Students → Recently deleted;
-- nothing erases a student for good.
--
-- How: the table becomes students_all, and `students` is a view of the rows
-- that aren't deleted. Every query that reads `students` (about a hundred)
-- hides deleted students without a filter of its own, and new queries are
-- safe by default. Only Recently deleted and restore read students_all.
-- Existing foreign keys follow the rename; inserts and updates through the
-- view reach the table (and its trg_default_school_year trigger) as before.
--
-- FROM NOW ON:
--   - schema changes go to students_all (ALTER TABLE students_all ...), and
--     new foreign keys reference students_all(student_id);
--   - the view lists the columns it had when it was made: after adding a
--     column, re-run the CREATE OR REPLACE VIEW below so `students` shows it.
--
-- Run BEFORE deploying the backend that reads deleted_at. Idempotent.

BEGIN;

ALTER TABLE IF EXISTS students ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS students ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(user_id) ON DELETE SET NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'students' AND relkind = 'r' AND relnamespace = 'public'::regnamespace) THEN
    ALTER TABLE students RENAME TO students_all;
  END IF;
END $$;

-- The Recently deleted list, per school and year.
CREATE INDEX IF NOT EXISTS students_deleted_idx ON students_all (school, school_year_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;

-- security_invoker: the table's row-level security still applies to anyone
-- reading through the view (the API's own connection owns the table, as
-- before). The public API roles get nothing.
CREATE OR REPLACE VIEW students WITH (security_invoker = true) AS
  SELECT * FROM students_all WHERE deleted_at IS NULL;
REVOKE ALL ON students FROM anon, authenticated;

COMMIT;
