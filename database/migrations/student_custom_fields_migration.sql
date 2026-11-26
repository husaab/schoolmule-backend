-- Student custom fields (2026-11-26).
--
-- A school can keep facts about its students that SchoolMule has no column
-- for ("Bus route", "Photo consent"), and one student can carry one-off notes
-- of their own. The forms import can save a form question into one of these
-- fields, so an answer with no matching student column is no longer dropped.
--
--   student_custom_fields          the school's list of fields (label, type,
--                                  dropdown options, order). Deleting a field
--                                  only hides it (deleted_at): the values stay
--                                  on the students and School settings restores it.
--   students_all.custom_fields     { "values": { "<field_id>": value },
--                                    "notes":  [ { "label", "value" } ] }
--                                  values: string (text, textarea, select,
--                                  date as YYYY-MM-DD), number, or boolean.
--                                  A field with no value has no key.
--   registration_field_mappings    target_field 'custom' + custom_field_id
--                                  points a form question at a field; 'gender'
--                                  becomes an import target too.
--   registration_form_submissions  import_created_student: whether importing
--                                  the submission created its student (as
--                                  opposed to filling in one that existed), so
--                                  undo never deletes a student it didn't make.
--
-- Staff only: nothing here is read by the parent or student portals.
-- Run BEFORE deploying the backend that reads custom_fields. Idempotent.

BEGIN;

-- Fail fast instead of queueing behind a long query: students_all is read all
-- day, and a waiting ALTER TABLE would hold up everything behind it.
SET LOCAL lock_timeout = '5s';

-- 1. The school's fields ------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_custom_fields (
  field_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school      school NOT NULL,
  label       VARCHAR(80) NOT NULL CHECK (btrim(label) <> ''),
  field_type  VARCHAR(10) NOT NULL
              CHECK (field_type IN ('text', 'textarea', 'number', 'date', 'select', 'boolean')),
  -- select only: a JSON array of the choices, in display order
  options     JSONB,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  deleted_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
  CONSTRAINT student_custom_fields_options_ck CHECK (
    (field_type = 'select' AND options IS NOT NULL AND jsonb_typeof(options) = 'array')
    OR (field_type <> 'select' AND options IS NULL)
  )
);

-- One live field per name in a school; a hidden field doesn't hold its name.
CREATE UNIQUE INDEX IF NOT EXISTS uq_student_custom_fields_label
  ON student_custom_fields (school, lower(btrim(label))) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_student_custom_fields_order
  ON student_custom_fields (school, sort_order);

ALTER TABLE student_custom_fields ENABLE ROW LEVEL SECURITY;

-- 2. The values, on the student ------------------------------------------------
ALTER TABLE students_all
  ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{"values":{},"notes":[]}'::jsonb;

-- `students` lists the columns it had when it was made
-- (student_soft_delete_migration.sql), so it is re-made to show the new one.
CREATE OR REPLACE VIEW students WITH (security_invoker = true) AS
  SELECT * FROM students_all WHERE deleted_at IS NULL;
REVOKE ALL ON students FROM anon, authenticated;

-- 3. Import mapping: custom fields and gender as targets -----------------------
ALTER TABLE registration_field_mappings
  ADD COLUMN IF NOT EXISTS custom_field_id UUID
  REFERENCES student_custom_fields(field_id) ON DELETE CASCADE;

ALTER TABLE registration_field_mappings
  DROP CONSTRAINT IF EXISTS registration_field_mappings_target_field_check;
ALTER TABLE registration_field_mappings
  ADD CONSTRAINT registration_field_mappings_target_field_check CHECK (target_field IN (
    'name', 'grade', 'oen', 'dateOfBirth', 'medicalNotes', 'address',
    'healthCardNumber', 'emergencyContact',
    'motherName', 'motherEmail', 'motherPhone',
    'fatherName', 'fatherEmail', 'fatherPhone',
    'studentEmail', 'gender', 'custom'
  ));

ALTER TABLE registration_field_mappings
  DROP CONSTRAINT IF EXISTS registration_field_mappings_custom_ck;
ALTER TABLE registration_field_mappings
  ADD CONSTRAINT registration_field_mappings_custom_ck
  CHECK ((target_field = 'custom') = (custom_field_id IS NOT NULL));

-- A built-in student field is still fed by one question per form, but several
-- questions may each feed their own custom field, so UNIQUE (form_id,
-- target_field) gives way to two partial indexes. The constraint is found by
-- its columns rather than by its generated name.
DO $$
DECLARE
  c TEXT;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'registration_field_mappings'::regclass
      AND con.contype = 'u'
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM unnest(con.conkey) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      ) = ARRAY['form_id', 'target_field']
  LOOP
    EXECUTE format('ALTER TABLE registration_field_mappings DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_field_mappings_form_target
  ON registration_field_mappings (form_id, target_field) WHERE target_field <> 'custom';
CREATE UNIQUE INDEX IF NOT EXISTS uq_field_mappings_form_custom
  ON registration_field_mappings (form_id, custom_field_id) WHERE custom_field_id IS NOT NULL;

-- 4. Undo: did the import create the student? ----------------------------------
ALTER TABLE registration_form_submissions
  ADD COLUMN IF NOT EXISTS import_created_student BOOLEAN NOT NULL DEFAULT FALSE;

-- Imports made before this column: a created student was inserted in the same
-- transaction that marked the submission imported, so both carry that
-- transaction's NOW(); a student the import only filled in was created
-- earlier. Anything this misses stays FALSE, which only withholds "delete the
-- student too" on undo — the safe direction.
--
-- students_all.created_at has no time zone (it holds the UTC wall time the
-- API's sessions wrote) while imported_at has one, so the two are compared
-- in UTC whatever the session running this migration is set to.
SET LOCAL TIME ZONE 'UTC';
UPDATE registration_form_submissions s
SET import_created_student = TRUE
FROM students_all st
WHERE st.student_id = s.imported_student_id
  AND st.source_submission_id = s.submission_id
  AND s.imported_at IS NOT NULL
  AND st.created_at = s.imported_at
  AND s.import_created_student = FALSE;

COMMIT;
