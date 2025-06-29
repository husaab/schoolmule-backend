const parentStudentQueries = {
  // GET /parent-students?school=X - Get all parent-student relations by school
  selectParentStudentsBySchool: `
    SELECT
      ps.parent_student_link_id,
      ps.student_id,
      ps.parent_id,
      ps.parent_name,
      ps.parent_email,
      ps.parent_number,
      ps.relation,
      ps.school,
      ps.created_at,
      s.name as student_name,
      s.grade as student_grade,
      u.first_name as parent_first_name,
      u.last_name as parent_last_name,
      u.email as parent_user_email
    FROM parent_students ps
    LEFT JOIN students s ON ps.student_id = s.student_id
    LEFT JOIN users u ON ps.parent_id = u.user_id
    WHERE ps.school = $1
    ORDER BY s.name, ps.parent_name
  `,

  // GET /parent-students/:id - Get parent-student relation by ID
  selectParentStudentById: `
    SELECT
      ps.parent_student_link_id,
      ps.student_id,
      ps.parent_id,
      ps.parent_name,
      ps.parent_email,
      ps.parent_number,
      ps.relation,
      ps.school,
      ps.created_at,
      s.name as student_name,
      s.grade as student_grade,
      u.first_name as parent_first_name,
      u.last_name as parent_last_name,
      u.email as parent_user_email
    FROM parent_students ps
    LEFT JOIN students s ON ps.student_id = s.student_id
    LEFT JOIN users u ON ps.parent_id = u.user_id
    WHERE ps.parent_student_link_id = $1
  `,

  // GET /parent-students/student/:studentId - Get all parent relations for a student
  selectParentsByStudentId: `
    SELECT
      ps.parent_student_link_id,
      ps.student_id,
      ps.parent_id,
      ps.parent_name,
      ps.parent_email,
      ps.parent_number,
      ps.relation,
      ps.school,
      ps.created_at,
      u.first_name as parent_first_name,
      u.last_name as parent_last_name,
      u.email as parent_user_email
    FROM parent_students ps
    LEFT JOIN users u ON ps.parent_id = u.user_id
    WHERE ps.student_id = $1
    ORDER BY ps.relation
  `,

  // GET /parent-students/parent/:parentId - Get all student relations for a parent
  selectStudentsByParentId: `
    SELECT
      ps.parent_student_link_id,
      ps.student_id,
      ps.parent_id,
      ps.parent_name,
      ps.parent_email,
      ps.parent_number,
      ps.relation,
      ps.school,
      ps.created_at,
      s.name as student_name,
      s.grade as student_grade,
      s.oen as student_oen,
      s.homeroom_teacher_id,
      ht.first_name as homeroom_teacher_first_name,
      ht.last_name as homeroom_teacher_last_name
    FROM parent_students ps
    LEFT JOIN students s ON ps.student_id = s.student_id
    LEFT JOIN users ht ON s.homeroom_teacher_id = ht.user_id
    WHERE ps.parent_id = $1
    ORDER BY s.grade, s.name
  `,

  // POST /parent-students - Create new parent-student relation
  createParentStudent: `
    INSERT INTO parent_students (
      student_id,
      parent_id,
      parent_name,
      parent_email,
      parent_number,
      relation,
      school
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING
      parent_student_link_id,
      student_id,
      parent_id,
      parent_name,
      parent_email,
      parent_number,
      relation,
      school,
      created_at
  `,

  // PATCH /parent-students/:id - Update parent-student relation
  updateParentStudent: `
    UPDATE parent_students
    SET
      parent_id = $1,
      parent_name = $2,
      parent_email = $3,
      parent_number = $4,
      relation = $5
    WHERE parent_student_link_id = $6
    RETURNING
      parent_student_link_id,
      student_id,
      parent_id,
      parent_name,
      parent_email,
      parent_number,
      relation,
      school,
      created_at
  `,

  // DELETE /parent-students/:id - Delete parent-student relation
  deleteParentStudent: `
    DELETE FROM parent_students
    WHERE parent_student_link_id = $1
  `,

  // Check if parent-student relation already exists
  checkExistingRelation: `
    SELECT parent_student_link_id
    FROM parent_students
    WHERE student_id = $1 AND parent_id = $2
  `
};

module.exports = parentStudentQueries;