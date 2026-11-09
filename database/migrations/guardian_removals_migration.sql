-- ============================================================
-- Guardians from the student file, and the office's say over them.
--
-- A staff message turns the mother and father on the student file into
-- parent_students rows and invites them. Two things are needed for that to
-- be safe:
--
-- parent_students.source: 'file' for a row made from the student file,
-- 'typed' for one a staff member typed into New message, NULL for everything
-- else (the office's Relations page, approvals, imports, older rows). Only a
-- 'typed' row can be changed from New message, and an un-invited 'file' row
-- is dropped when the file no longer has that address.
--
-- guardian_removals: an address the office took off a student. Without it,
-- the next staff message would read the address from the file again and
-- re-invite someone the office removed.
--
-- Additive only. Apply BEFORE the backend that reads them. Safe to re-run.
-- ============================================================
BEGIN;

ALTER TABLE parent_students ADD COLUMN IF NOT EXISTS source TEXT CHECK (source IN ('file', 'typed'));

CREATE TABLE IF NOT EXISTS guardian_removals (
  student_id  UUID NOT NULL REFERENCES students_all(student_id) ON DELETE CASCADE,
  -- Lower-cased and trimmed, as every guardian lookup compares it.
  email       TEXT NOT NULL,
  removed_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
  removed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (student_id, email)
);

ALTER TABLE guardian_removals ENABLE ROW LEVEL SECURITY;

COMMIT;
