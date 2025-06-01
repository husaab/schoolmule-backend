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
      mother_name,
      mother_email,
      mother_number,
      father_name,
      father_email,
      father_number,
      emergency_contact,
      created_at,
      last_modified_at
    FROM students
  `,

  selectStudentsBySchool: `
    SELECT
      student_id,
      name,
      school,
      homeroom_teacher_id,
      grade,
      oen,
      mother_name,
      mother_email,
      mother_number,
      father_name,
      father_email,
      father_number,
      emergency_contact,
      created_at,
      last_modified_at
    FROM students
    WHERE school = $1
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
      mother_name,
      mother_email,
      mother_number,
      father_name,
      father_email,
      father_number,
      emergency_contact,
      created_at,
      last_modified_at
    FROM students
    WHERE student_id = $1
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
      emergency_contact
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
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
      school               = COALESCE($5, school),
      mother_name          = COALESCE($6, mother_name),
      mother_email         = COALESCE($7, mother_email),
      mother_number        = COALESCE($8, mother_number),
      father_name          = COALESCE($9, father_name),
      father_email         = COALESCE($10, father_email),
      father_number        = COALESCE($11, father_number),
      emergency_contact    = COALESCE($12, emergency_contact),
      last_modified_at     = NOW()
    WHERE student_id = $13
    RETURNING *
  `,

  // DELETE /students/:id
  deleteStudentById: `
    DELETE FROM students
    WHERE student_id = $1
  `
};

module.exports = studentQueries;