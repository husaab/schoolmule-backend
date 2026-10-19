const { studentAvatarSql } = require("../utils/avatar");

const studentQueries = {
  // GET    /students
  selectAllStudents: `
    SELECT
      student_id,
      name,
      school,
      homeroom_teacher_id,
      grade,
      oen,
      student_email,
      mother_name,
      mother_email,
      mother_number,
      father_name,
      father_email,
      father_number,
      emergency_contact,
      date_of_birth,
      address,
      health_card_number,
      medical_notes,
      source_submission_id,
      created_at,
      last_modified_at,
      is_archived,
      archived_at,
      archived_by
    FROM students
    WHERE is_archived = false
  `,

  selectStudentsBySchool: `
    SELECT
      student_id,
      name,
      school,
      homeroom_teacher_id,
      grade,
      oen,
      student_email,
      mother_name,
      mother_email,
      mother_number,
      father_name,
      father_email,
      father_number,
      emergency_contact,
      date_of_birth,
      address,
      health_card_number,
      medical_notes,
      source_submission_id,
      created_at,
      last_modified_at,
      is_archived,
      archived_at,
      archived_by,
      school_year_id,
      previous_student_id,
      ${studentAvatarSql('students')}
    FROM students
    WHERE school = $1 AND school_year_id = $2 AND is_archived = false
  `,

  // GET    /students/:id
  selectStudentById: `
    SELECT
      student_id,
      name,
      school,
      homeroom_teacher_id,
      grade,
      oen,
      student_email,
      mother_name,
      mother_email,
      mother_number,
      father_name,
      father_email,
      father_number,
      emergency_contact,
      date_of_birth,
      address,
      health_card_number,
      medical_notes,
      source_submission_id,
      created_at,
      last_modified_at,
      is_archived,
      archived_at,
      archived_by,
      ${studentAvatarSql('students')}
    FROM students
    WHERE student_id = $1
  `,

  // GET /students/:id and the archive checks: a student of the caller's
  // school only. $1 = student_id, $2 = school
  selectStudentInSchool: `
    SELECT
      student_id,
      name,
      school,
      homeroom_teacher_id,
      grade,
      oen,
      student_email,
      mother_name,
      mother_email,
      mother_number,
      father_name,
      father_email,
      father_number,
      emergency_contact,
      date_of_birth,
      address,
      health_card_number,
      medical_notes,
      source_submission_id,
      created_at,
      last_modified_at,
      is_archived,
      archived_at,
      archived_by,
      ${studentAvatarSql('students')}
    FROM students
    WHERE student_id = $1 AND school = $2
  `,

  // POST   /students
  createStudent: `
    INSERT INTO students (
      name,
      homeroom_teacher_id,
      grade,
      oen,
      school,
      mother_name,
      mother_email,
      mother_number,
      father_name,
      father_email,
      father_number,
      emergency_contact,
      school_year_id,
      date_of_birth,
      address,
      health_card_number,
      medical_notes,
      student_email
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
    )
    RETURNING *
  `,

  // PATCH  /students/:id
   updateStudentById: `
    UPDATE students
    SET
      name                 = COALESCE($1, name),
      homeroom_teacher_id  = COALESCE($2, homeroom_teacher_id),
      grade                = COALESCE($3, grade),
      oen                  = COALESCE($4, oen),
      mother_name          = COALESCE($6, mother_name),
      mother_email         = COALESCE($7, mother_email),
      mother_number        = COALESCE($8, mother_number),
      father_name          = COALESCE($9, father_name),
      father_email         = COALESCE($10, father_email),
      father_number        = COALESCE($11, father_number),
      emergency_contact    = COALESCE($12, emergency_contact),
      date_of_birth        = COALESCE($14, date_of_birth),
      address              = COALESCE($15, address),
      health_card_number   = COALESCE($16, health_card_number),
      medical_notes        = COALESCE($17, medical_notes),
      -- $18 = the body carried studentEmail (so null/'' clears it), $19 = the value.
      student_email        = CASE WHEN $18::boolean
                                  THEN NULLIF(LOWER(TRIM($19)), '') ELSE student_email END,
      last_modified_at     = NOW()
    -- $5 = the caller's school: only their own students, and a student never
    -- moves to another school here.
    WHERE student_id = $13 AND school::text = $5::text
    RETURNING *
  `,

  // DELETE /students/:id
  //  $1 = student_id, $2 = school
  deleteStudentById: `
    DELETE FROM students
    WHERE student_id = $1 AND school = $2
  `,

  selectStudentsByGrade: `
    SELECT student_id
    FROM students
    WHERE school = $1 AND school_year_id = $2 AND grade = $3 AND is_archived = false
  `,

  // Archive-related queries
  selectArchivedStudentsBySchool: `
    SELECT
      student_id,
      name,
      school,
      homeroom_teacher_id,
      grade,
      oen,
      student_email,
      mother_name,
      mother_email,
      mother_number,
      father_name,
      father_email,
      father_number,
      emergency_contact,
      date_of_birth,
      address,
      health_card_number,
      medical_notes,
      source_submission_id,
      created_at,
      last_modified_at,
      is_archived,
      archived_at,
      archived_by,
      school_year_id,
      previous_student_id
    FROM students
    WHERE school = $1 AND school_year_id = $2 AND is_archived = true
    ORDER BY archived_at DESC
  `,

  archiveStudent: `
    UPDATE students
    SET
      is_archived = true,
      archived_at = NOW(),
      archived_by = $2,
      last_modified_at = NOW()
    WHERE student_id = $1 AND school = $3
    RETURNING *
  `,

  unarchiveStudent: `
    UPDATE students
    SET
      is_archived = false,
      archived_at = NULL,
      archived_by = NULL,
      last_modified_at = NOW()
    WHERE student_id = $1 AND school = $2
    RETURNING *
  `,

  // For showing ALL students (including archived) with filter option
  selectAllStudentsWithArchived: `
    SELECT
      student_id,
      name,
      school,
      homeroom_teacher_id,
      grade,
      oen,
      student_email,
      mother_name,
      mother_email,
      mother_number,
      father_name,
      father_email,
      father_number,
      emergency_contact,
      date_of_birth,
      address,
      health_card_number,
      medical_notes,
      source_submission_id,
      created_at,
      last_modified_at,
      is_archived,
      archived_at,
      archived_by,
      school_year_id,
      previous_student_id
    FROM students
    WHERE school = $1 AND school_year_id = $2
    ORDER BY is_archived ASC, name ASC
  `
};

module.exports = studentQueries;