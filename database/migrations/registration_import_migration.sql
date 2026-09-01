-- registration_import_migration.sql
--
-- Adds the ability to import registration form submissions as student records.
--
-- Three additive changes:
--   1. `students` gains the profile fields registration forms collect but had
--      nowhere to store (date of birth, address, medical notes, health card),
--      plus a back-link to the submission it was imported from.
--   2. `registration_form_submissions` gains forward import-tracking columns.
--      The `status` CHECK constraint is deliberately NOT widened: status stays
--      a human workflow field (new / reviewed / archived), and "imported" is
--      tracked separately so a submission can be both imported and archived.
--   3. A new `registration_field_mappings` table storing, per form, which form
--      field feeds which student field — configured once, reused every import.
--
-- Entirely additive: no column drops, no type changes, no backfill required.

BEGIN;

-- ─── 1. students: new profile columns + import back-link ──────────────
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS date_of_birth        DATE,
  ADD COLUMN IF NOT EXISTS medical_notes        TEXT,
  ADD COLUMN IF NOT EXISTS address              TEXT,
  ADD COLUMN IF NOT EXISTS health_card_number   TEXT,
  ADD COLUMN IF NOT EXISTS source_submission_id UUID
    REFERENCES registration_form_submissions(submission_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_students_source_submission
  ON students (source_submission_id)
  WHERE source_submission_id IS NOT NULL;

-- ─── 2. registration_form_submissions: import tracking ────────────────
ALTER TABLE registration_form_submissions
  ADD COLUMN IF NOT EXISTS imported_student_id UUID
    REFERENCES students(student_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS imported_by UUID
    REFERENCES users(user_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_submissions_imported_student
  ON registration_form_submissions (imported_student_id)
  WHERE imported_student_id IS NOT NULL;

-- Supports the "not yet imported" filter, which is the common case admins
-- work from when they have hundreds of submissions and dozens left to import.
CREATE INDEX IF NOT EXISTS idx_submissions_form_not_imported
  ON registration_form_submissions (form_id)
  WHERE imported_student_id IS NULL;

-- ─── 3. per-form field → student field mapping ────────────────────────
-- A dedicated table rather than a JSONB column on registration_forms, for the
-- same reason registration_form_fields is its own table: mappings need FK
-- cascade so that deleting a form field can't leave a dangling mapping behind.
CREATE TABLE IF NOT EXISTS registration_field_mappings (
  mapping_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id      UUID NOT NULL REFERENCES registration_forms(form_id) ON DELETE CASCADE,
  field_id     UUID NOT NULL REFERENCES registration_form_fields(field_id) ON DELETE CASCADE,
  target_field VARCHAR(40) NOT NULL CHECK (target_field IN (
    'name', 'grade', 'oen', 'dateOfBirth', 'medicalNotes', 'address',
    'healthCardNumber', 'emergencyContact',
    'motherName', 'motherEmail', 'motherPhone',
    'fatherName', 'fatherEmail', 'fatherPhone'
  )),
  -- For choice fields feeding an enum target (grade), maps each of the field's
  -- options to the target's value, e.g. {"Junior Kindergarten": "JK"}.
  value_map    JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One source field feeds at most one student field, and each student field
  -- is fed by at most one source field. Both directions must be unambiguous
  -- for the import to be deterministic.
  UNIQUE (form_id, field_id),
  UNIQUE (form_id, target_field)
);

CREATE INDEX IF NOT EXISTS idx_field_mappings_form
  ON registration_field_mappings (form_id);

COMMIT;
