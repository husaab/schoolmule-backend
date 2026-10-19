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
      school_year_id,
      banner_key,
      banner_path,
      icon_key,
      color,
      accept_late,
      email_new_posts,
      show_class_average,
      archived_at,
      created_at,
      last_modified_at
    FROM public.classes
    WHERE school = $1 AND school_year_id = $2
    ORDER BY grade, subject
  `,

  //
  // Canonical term name for a class, resolved through the terms FK so it
  // always equals what report-card generation queries with. Used to anchor
  // feedback rows to the class's own term (never a teacher-selected term).
  //
  selectClassTerm: `
    SELECT t.name AS term
    FROM public.classes c
    JOIN public.terms t ON t.term_id = c.term_id
    WHERE c.class_id = $1
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
      school_year_id,
      banner_key,
      banner_path,
      icon_key,
      color,
      accept_late,
      email_new_posts,
      show_class_average,
      archived_at,
      created_at,
      last_modified_at
    FROM public.classes
    WHERE class_id = $1
  `,

  //
  // 3) GET /classes/grade/:grade?school={school}
  //    → List all classes for a given school AND grade
  //    $1 = school, $2 = grade, $3 = school_year_id
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
      school_year_id,
      banner_key,
      banner_path,
      icon_key,
      color,
      accept_late,
      email_new_posts,
      show_class_average,
      archived_at,
      created_at,
      last_modified_at
    FROM public.classes
    WHERE school = $1
      AND grade  = $2
      AND school_year_id = $3
    ORDER BY subject
  `,

  //
  // 4) GET /classes/teacher/:teacherName
  //    → List all classes for a given teacher name
  //    $1 = teacher_name, $2 = school_year_id
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
      school_year_id,
      banner_key,
      banner_path,
      icon_key,
      color,
      accept_late,
      email_new_posts,
      show_class_average,
      archived_at,
      created_at,
      last_modified_at
    FROM public.classes
    WHERE teacher_name = $1
      AND school_year_id = $2
    ORDER BY grade, subject
  `,

  //
  // 5) POST /classes
  //    → Create a new class
  //
  createClass: `
    INSERT INTO public.classes
      (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING
      class_id,
      school,
      grade,
      subject,
      teacher_name,
      teacher_id,
      term_id,
      term_name,
      school_year_id,
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

    // $1 = teacher_id, $2 = school_year_id
    selectClassesByTeacherId: `
      SELECT
        c.class_id,
        c.school,
        c.grade,
        c.subject,
        c.teacher_name,
        c.teacher_id,
        c.term_id,
        c.term_name,
        c.school_year_id,
        c.banner_key,
        c.banner_path,
        c.icon_key,
        c.color,
        c.accept_late,
        c.email_new_posts,
        c.show_class_average,
        c.archived_at,
        c.created_at,
        c.last_modified_at
      FROM classes c
      WHERE c.teacher_id = $1
        AND c.school_year_id = $2

      UNION

      SELECT
        c.class_id,
        c.school,
        c.grade,
        c.subject,
        c.teacher_name,
        c.teacher_id,
        c.term_id,
        c.term_name,
        c.school_year_id,
        c.banner_key,
        c.banner_path,
        c.icon_key,
        c.color,
        c.accept_late,
        c.email_new_posts,
        c.show_class_average,
        c.archived_at,
        c.created_at,
        c.last_modified_at
      FROM classes c
      INNER JOIN class_teachers ct ON ct.class_id = c.class_id
      WHERE ct.teacher_id = $1
        AND c.school_year_id = $2

      ORDER BY grade, subject
    `,

    // ── Additional Teachers queries ──

    selectAdditionalTeachersByClassId: `
      SELECT
        ct.teacher_id,
        ct.created_at,
        u.first_name,
        u.last_name,
        u.email
      FROM class_teachers ct
      INNER JOIN users u ON u.user_id = ct.teacher_id
      WHERE ct.class_id = $1
      ORDER BY u.last_name, u.first_name
    `,

    selectAdditionalTeachersByClassIds: `
      SELECT
        ct.class_id,
        ct.teacher_id,
        ct.created_at,
        u.first_name,
        u.last_name,
        u.email
      FROM class_teachers ct
      INNER JOIN users u ON u.user_id = ct.teacher_id
      WHERE ct.class_id = ANY($1::uuid[])
      ORDER BY u.last_name, u.first_name
    `,

    insertClassTeacher: `
      INSERT INTO class_teachers (class_id, teacher_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      RETURNING class_id, teacher_id, created_at
    `,

    deleteClassTeacher: `
      DELETE FROM class_teachers
      WHERE class_id = $1
        AND teacher_id = $2
    `,

    // The copy keeps the source's explicit picks (banner, icon, color) and options.
    // A pick left at the default stays NULL, so it follows the copy's own subject.
    // $1 = new class_id, $2 = source class_id
    duplicateCopyIdentity: `
      UPDATE classes n
      SET banner_key         = s.banner_key,
          banner_path        = s.banner_path,
          icon_key           = s.icon_key,
          color              = s.color,
          accept_late        = s.accept_late,
          email_new_posts    = s.email_new_posts,
          show_class_average = s.show_class_average
      FROM classes s
      WHERE n.class_id = $1 AND s.class_id = $2
    `,

    duplicateSelectClassTeachers: `
      SELECT teacher_id
      FROM class_teachers
      WHERE class_id = $1
    `,

    duplicateInsertClassTeachers: `
      INSERT INTO class_teachers (class_id, teacher_id)
      SELECT $1, unnest($2::uuid[])
      ON CONFLICT DO NOTHING
    `,

    // ── Duplicate Class queries ──

    duplicateSelectAssessments: `
      SELECT
        assessment_id,
        class_id,
        name,
        weight_percent,
        parent_assessment_id,
        is_parent,
        sort_order,
        max_score,
        weight_points
      FROM assessments
      WHERE class_id = $1
      ORDER BY is_parent DESC, sort_order ASC, created_at ASC
    `,

    duplicateInsertAssessment: `
      INSERT INTO assessments
        (assessment_id, class_id, name, weight_percent, parent_assessment_id, is_parent, sort_order, max_score, weight_points, date)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
      RETURNING *
    `,

    // Classwork copies as drafts: topics (same order), then each live item.
    duplicateSelectTopics: `
      SELECT topic_id, name, sort_order
      FROM classwork_topics
      WHERE class_id = $1
      ORDER BY sort_order, created_at, topic_id
    `,

    duplicateInsertTopic: `
      INSERT INTO classwork_topics (class_id, name, sort_order)
      VALUES ($1, $2, $3)
      RETURNING topic_id
    `,

    duplicateSelectItems: `
      SELECT item_id, kind, title, instructions, topic_id, submission_mode, assessment_id,
             email_students, remind_students, show_early, sort_order
      FROM classwork_items
      WHERE class_id = $1 AND deleted_at IS NULL
      ORDER BY created_at, item_id
    `,

    // The copied column's item (made by the insert trigger) takes the source
    // assignment's or quiz's shape, as a draft with no dates.
    // $1 new assessment_id, $2 kind, $3 instructions, $4 topic_id, $5 submission_mode,
    // $6 email_students, $7 remind_students, $8 show_early, $9 sort_order, $10 created_by
    duplicateConvertLinkedItem: `
      UPDATE classwork_items
      SET kind = $2, title = NULL, instructions = $3, topic_id = $4, submission_mode = $5,
          status = 'draft', posted_at = NULL, publish_at = NULL, due_at = NULL,
          email_students = $6, remind_students = $7, show_early = $8, sort_order = $9,
          created_by = $10, created_at = NOW(), edited_at = NULL
      WHERE assessment_id = $1
      RETURNING item_id
    `,

    // A plain gradebook assessment stays the posted item the insert trigger
    // made for its copied column (final ruling I2, D11: plain assessments
    // show in Classwork like a new column's); it takes the source's topic,
    // instructions, "show early" and order only.
    // $1 new assessment_id, $2 instructions, $3 topic_id, $4 show_early, $5 sort_order
    duplicateShapeAssessmentItem: `
      UPDATE classwork_items
      SET instructions = $2, topic_id = $3, show_early = $4, sort_order = $5
      WHERE assessment_id = $1 AND kind = 'assessment'
      RETURNING item_id
    `,

    // An item with no column, as a draft with no dates.
    // $1 class_id, $2 kind, $3 title, $4 instructions, $5 topic_id, $6 submission_mode,
    // $7 email_students, $8 remind_students, $9 show_early, $10 sort_order, $11 created_by
    duplicateInsertItem: `
      INSERT INTO classwork_items (class_id, kind, title, instructions, topic_id, submission_mode, status,
                                   email_students, remind_students, show_early, sort_order, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9, $10, $11)
      RETURNING item_id
    `,

    duplicateSelectStudents: `
      SELECT student_id
      FROM class_students
      WHERE class_id = $1
    `,

    duplicateEnrollStudents: `
      INSERT INTO class_students (class_id, student_id)
      SELECT $1, unnest($2::uuid[])
      ON CONFLICT DO NOTHING
    `,
};

module.exports = classQueries;
