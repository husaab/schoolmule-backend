-- Staff titles and student gender.
--
-- users.honorific: how parents see a staff member's name ("Ms. Doha
-- Chahade" in emails, buttons and the parent portal). Staff only; parents and
-- students have none. Edited from Admin Panel → Users. NULL = the plain name.
--
-- students.gender: 'male' | 'female', NULL = not set. Edited on the student
-- form; default avatars use it before guessing from the name.
--
-- Additive and safe to re-run. Apply before the backend that reads them.

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS honorific TEXT;
COMMENT ON COLUMN users.honorific IS 'Staff title shown before the name to parents: Mr. | Ms. | Mrs. | Dr. NULL = plain name.';
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_honorific_check CHECK (honorific IS NULL OR honorific IN ('Mr.', 'Ms.', 'Mrs.', 'Dr.'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE students ADD COLUMN IF NOT EXISTS gender TEXT;
COMMENT ON COLUMN students.gender IS 'male | female. NULL = not set.';
DO $$ BEGIN
  ALTER TABLE students ADD CONSTRAINT students_gender_check CHECK (gender IS NULL OR gender IN ('male', 'female'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
