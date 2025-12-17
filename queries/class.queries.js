// queries/class.queries.js

const classQueries = {
  //
  // 1) GET /classes?school={school}
  //    → List all classes for a given school
  //
   selectClassesBySchool: `
    SELECT
      class_id,
      school,
      grade,
      subject,
      teacher_name,
      teacher_id,
      term_id,
      term_name,
      created_at,
      last_modified_at
    FROM public.classes
    WHERE school = $1
    ORDER BY grade, subject
  `,

  //
  // 2) GET /classes/:id
  //    → Fetch one class by its UUID
  //
  selectClassById: `
    SELECT
      class_id,
      school,
      grade,
      subject,
      teacher_name,
      teacher_id,
      term_id,
      term_name,
      created_at,
      last_modified_at
    FROM public.classes
    WHERE class_id = $1
  `,

  //
  // 3) GET /classes/grade/:grade?school={school}
  //    → List all classes for a given school AND grade
  //
  selectClassesByGrade: `
    SELECT
      class_id,
      school,
      grade,
      subject,
      teacher_name,
      teacher_id,
      term_id,
      term_name,
      created_at,
      last_modified_at
    FROM public.classes
    WHERE school = $1
      AND grade  = $2
    ORDER BY subject
  `,

  //
  // 4) GET /classes/teacher/:teacherName
  //    → List all classes for a given teacher name
  //
  selectClassesByTeacher: `
    SELECT
      class_id,
      school,
      grade,
      subject,
      teacher_name,
      teacher_id,
      term_id,
      term_name,
      created_at,
      last_modified_at
    FROM public.classes
    WHERE teacher_name = $1
    ORDER BY grade, subject
  `,

  //
  // 5) POST /classes
  //    → Create a new class
  //
  createClass: `
    INSERT INTO public.classes
      (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING
      class_id,
      school,
      grade,
      subject,
      teacher_name,
      teacher_id,
      term_id,
      term_name,
      created_at,
      last_modified_at
  `,

  //
  // 6) PATCH /classes/:id
  //    → Update any field of an existing class
  //
  updateClassById: `
    UPDATE public.classes
    SET
      school            = COALESCE($1, school),
      grade             = COALESCE($2, grade),
      subject           = COALESCE($3, subject),
      teacher_name      = COALESCE($4, teacher_name),
      teacher_id        = COALESCE($5, teacher_id),
      term_id           = COALESCE($6, term_id),
      term_name         = COALESCE($7, term_name),
      last_modified_at  = NOW()
    WHERE class_id = $8
    RETURNING
      class_id,
      school,
      grade,
      subject,
      teacher_name,
      teacher_id,
      term_id,
      term_name,
      created_at,
      last_modified_at
  `,

  //
  // 7) DELETE /classes/:id
  //    → Delete a class by its UUID
  //
  deleteClassById: `
    DELETE FROM classes
    WHERE class_id = $1
  `,

  //
  // 8) GET /classes/:classId/students
  //    → List all students in a given class (via class_students join table)
  //
  selectStudentsInClass: `
    SELECT
      s.student_id,
      s.name,
      s.school,
      s.grade,
      s.oen,
      s.mother_name,
      s.mother_email,
      s.mother_number,
      s.father_name,
      s.father_email,
      s.father_number,
      s.emergency_contact,
      s.created_at,
      s.last_modified_at,
      s.is_archived,
      s.archived_at,
      s.archived_by
    FROM students AS s
    INNER JOIN class_students AS cs
      ON s.student_id = cs.student_id
    WHERE cs.class_id = $1 AND s.is_archived = false
    ORDER BY s.name
  `,

  //
  // 9) GET /classes/:classId/assessments
  //    → List all assessments (marking‐scheme items) for this class
  //
  selectAssessmentsByClass: `
    SELECT
      assessment_id,
      class_id,
      name,
      weight_percent,
      created_at,
      last_modified_at,
      parent_assessment_id,
      is_parent,
      sort_order,
      max_score,
      weight_points,
      date
    FROM assessments
    WHERE class_id = $1
    ORDER BY 
      CASE WHEN parent_assessment_id IS NULL THEN assessment_id ELSE parent_assessment_id END,
      is_parent DESC,
      sort_order ASC,
      created_at ASC
  `,

    createClassStudentRelation: `
      INSERT INTO class_students (class_id, student_id)
      VALUES ($1, $2)
      RETURNING *
    `,

    deleteClassStudentRelation: `
      DELETE FROM class_students
      WHERE class_id = $1
        AND student_id = $2
    `,

    selectClassesByTeacherId: `
      SELECT
        class_id,
        school,
        grade,
        subject,
        teacher_name,
        teacher_id,
        term_id,
        term_name,
        created_at,
        last_modified_at
      FROM classes
      WHERE teacher_id = $1
      ORDER BY grade, subject
    `,
};

module.exports = classQueries;
