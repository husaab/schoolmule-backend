// queries/registrationImport.queries.js
//
// SQL for the submission → student import feature: mapping CRUD, candidate
// loading, the import writes themselves, and the undo path.
//
// Every statement that touches a submission is scoped to the caller's school
// through registration_forms, so a submission UUID from another tenant matches
// nothing rather than leaking a row.

const registrationImportQueries = {
  // ─── Field mapping ────────────────────────────────────────────────────

  // A row either feeds a built-in student field (target_field) or one of the
  // school's custom fields (target_field 'custom' + custom_field_id), whose
  // definition comes back with it. A mapping to a field the school has since
  // deleted is left out: nothing is imported into a hidden field, and the row
  // is still there if the field is restored.
  selectMappingsByForm: `
    SELECT m.mapping_id, m.form_id, m.field_id, m.target_field, m.value_map,
           m.custom_field_id,
           cf.label AS custom_label, cf.field_type AS custom_type, cf.options AS custom_options
    FROM registration_field_mappings m
    JOIN registration_forms f ON m.form_id = f.form_id
    JOIN registration_form_fields q ON q.field_id = m.field_id
    LEFT JOIN student_custom_fields cf ON cf.field_id = m.custom_field_id
    WHERE m.form_id = $1 AND f.school = $2
      AND (m.custom_field_id IS NULL OR cf.deleted_at IS NULL)
    -- In the form's own order, so a row's values and its preview read the way
    -- the form does.
    ORDER BY q.sort_order, q.created_at, q.field_id
  `,

  // Mapping rows are saved as a full replace-set (matching how form fields are
  // saved), so the upsert keys on the form+field pair.
  upsertMapping: `
    INSERT INTO registration_field_mappings (form_id, field_id, target_field, value_map, custom_field_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (form_id, field_id)
    DO UPDATE SET target_field    = EXCLUDED.target_field,
                  value_map       = EXCLUDED.value_map,
                  custom_field_id = EXCLUDED.custom_field_id,
                  updated_at      = now()
    RETURNING *
  `,

  deleteMappingsByForm: `
    DELETE FROM registration_field_mappings WHERE form_id = $1
  `,

  // ─── Candidates ───────────────────────────────────────────────────────
  // Every column the fill-blanks diff needs to decide whether a field is
  // already populated on the existing student.
  selectStudentsForMatching: `
    SELECT
      student_id, name, grade, oen, date_of_birth, address, health_card_number,
      medical_notes, emergency_contact,
      mother_name, mother_email, mother_number,
      father_name, father_email, father_number,
      student_email, gender, custom_fields
    FROM students
    WHERE school = $1 AND school_year_id = $2 AND is_archived = false
  `,

  // ─── Submission scope resolution ──────────────────────────────────────

  selectSubmissionsByIds: `
    SELECT s.*,
      (SELECT name FROM students WHERE student_id = s.imported_student_id) AS imported_student_name
    FROM registration_form_submissions s
    JOIN registration_forms f ON s.form_id = f.form_id
    WHERE s.form_id = $1 AND f.school = $2 AND s.submission_id = ANY($3::uuid[])
    ORDER BY s.submitted_at DESC
  `,

  // ─── Import writes ────────────────────────────────────────────────────

  insertStudentFromSubmission: `
    INSERT INTO students (
      name, grade, school, school_year_id, homeroom_teacher_id,
      oen, date_of_birth, address, health_card_number, medical_notes,
      emergency_contact,
      mother_name, mother_email, mother_number,
      father_name, father_email, father_number,
      source_submission_id,
      student_email,
      gender,
      custom_fields
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11,
      $12, $13, $14,
      $15, $16, $17,
      $18,
      $19,
      $20,
      -- $21 = the custom fields as JSON text: { values, notes }
      $21::jsonb
    )
    RETURNING *
  `,

  // Fill-blanks-only: COALESCE keeps whatever the student already has, so a
  // non-null incoming value can only land in a column that is currently NULL.
  // NULLIF collapses whitespace-only values to NULL first, so a column holding
  // '' is treated as blank and can be filled.
  updateStudentFillBlanks: `
    UPDATE students SET
      name               = COALESCE(NULLIF(TRIM(name), ''), $2, name),
      grade              = COALESCE(grade, $3::"GRADE"),
      oen                = COALESCE(NULLIF(TRIM(oen), ''), $4),
      date_of_birth      = COALESCE(date_of_birth, $5::date),
      address            = COALESCE(NULLIF(TRIM(address), ''), $6),
      health_card_number = COALESCE(NULLIF(TRIM(health_card_number), ''), $7),
      medical_notes      = COALESCE(NULLIF(TRIM(medical_notes), ''), $8),
      emergency_contact  = COALESCE(NULLIF(TRIM(emergency_contact), ''), $9),
      mother_name        = COALESCE(NULLIF(TRIM(mother_name), ''), $10),
      mother_email       = COALESCE(NULLIF(TRIM(mother_email), ''), $11),
      mother_number      = COALESCE(NULLIF(TRIM(mother_number), ''), $12),
      father_name        = COALESCE(NULLIF(TRIM(father_name), ''), $13),
      father_email       = COALESCE(NULLIF(TRIM(father_email), ''), $14),
      father_number      = COALESCE(NULLIF(TRIM(father_number), ''), $15),
      student_email      = COALESCE(NULLIF(TRIM(student_email), ''), $16),
      gender             = COALESCE(NULLIF(TRIM(gender), ''), $17),
      -- $18 = { fieldId: value } for the custom fields to fill, as JSON text.
      -- What the student already has is on the right of ||, so it wins: a
      -- custom field that holds a value is never overwritten either.
      custom_fields      = jsonb_set(
                             custom_fields, '{values}',
                             COALESCE($18::jsonb, '{}'::jsonb) || COALESCE(custom_fields -> 'values', '{}'::jsonb)),
      last_modified_at   = NOW()
    WHERE student_id = $1
    RETURNING *
  `,

  // The `imported_student_id IS NULL` guard makes this the concurrency check:
  // if another admin's import committed first, this affects zero rows and the
  // caller treats the submission as already handled instead of double-importing.
  // $5 = true when this import created the student, false when it filled in
  // one that already existed: undo only ever deletes a student it created.
  markSubmissionImported: `
    UPDATE registration_form_submissions s
    SET imported_student_id = $2,
        imported_at = NOW(),
        imported_by = $3,
        import_created_student = $5,
        status = CASE WHEN s.status = 'new' THEN 'reviewed' ELSE s.status END
    FROM registration_forms f
    WHERE s.submission_id = $1
      AND s.form_id = f.form_id
      AND f.school = $4
      AND s.imported_student_id IS NULL
    RETURNING s.*
  `,

  // Links an updated (not created) student back to the submission that enriched
  // it, but only when it has no source yet — never steals provenance from an
  // earlier import.
  setStudentSourceSubmission: `
    UPDATE students
    SET source_submission_id = COALESCE(source_submission_id, $2)
    WHERE student_id = $1
    RETURNING *
  `,

  // ─── Side effects ─────────────────────────────────────────────────────

  assignHomeroomTeacher: `
    UPDATE students
    SET homeroom_teacher_id = $2, last_modified_at = NOW()
    WHERE student_id = ANY($1::uuid[])
  `,

  selectClassesByGradeForYear: `
    SELECT class_id, subject, grade
    FROM classes
    WHERE school = $1 AND school_year_id = $2 AND grade = $3::"GRADE"
  `,

  // ─── Undo ─────────────────────────────────────────────────────────────

  selectSubmissionForUndo: `
    SELECT s.submission_id, s.form_id, s.imported_student_id, s.status, s.import_created_student,
      (SELECT name FROM students WHERE student_id = s.imported_student_id) AS imported_student_name
    FROM registration_form_submissions s
    JOIN registration_forms f ON s.form_id = f.form_id
    WHERE s.submission_id = $1 AND f.school = $2
  `,

  // Another submission imported into the same student (one created them, a
  // later one filled them in): deleting the student would leave it pointing at
  // nobody. $1 student_id, $2 the submission being undone
  selectOtherSubmissionForStudent: `
    SELECT 1 FROM registration_form_submissions
    WHERE imported_student_id = $1 AND submission_id <> $2
    LIMIT 1
  `,

  clearSubmissionImport: `
    UPDATE registration_form_submissions s
    SET imported_student_id = NULL, imported_at = NULL, imported_by = NULL,
        import_created_student = FALSE
    FROM registration_forms f
    WHERE s.submission_id = $1
      AND s.form_id = f.form_id
      AND f.school = $2
    RETURNING s.*
  `,

  // Only this submission's mark: a student first imported from another
  // submission keeps that one as its source. $1 student_id, $2 submission_id
  clearStudentSourceSubmission: `
    UPDATE students SET source_submission_id = NULL
    WHERE student_id = $1 AND source_submission_id = $2
  `,

  // Undo import's "delete the student too": soft, like every student delete
  // (student.queries softDeleteStudent). $1 student_id, $2 school, $3 deleted_by
  softDeleteStudentScoped: `
    UPDATE students
    SET is_archived = TRUE, deleted_at = NOW(), deleted_by = $3, last_modified_at = NOW()
    WHERE student_id = $1 AND school = $2
    RETURNING student_id
  `,

  // Rolls back a student this same import transaction just inserted (another
  // import claimed the submission first): never a student anyone has used.
  deleteStudentScoped: `
    DELETE FROM students
    WHERE student_id = $1 AND school = $2
    RETURNING student_id
  `,
};

module.exports = registrationImportQueries;
