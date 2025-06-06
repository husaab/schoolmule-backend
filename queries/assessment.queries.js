// File: src/queries/assessment.queries.js

const assessmentQueries = {
  //
  // 1) GET /assessments/:id
  //    → Fetch a single assessment by its UUID
  //
  selectAssessmentById: `
    SELECT
      assessment_id,
      class_id,
      name,
      weight_percent,
      created_at,
      last_modified_at
    FROM assessments
    WHERE assessment_id = $1
  `,

  //
  // 2) GET /assessments/class/:classId
  //    → List all assessments for a given class
  //
  selectAssessmentsByClass: `
    SELECT
      assessment_id,
      class_id,
      name,
      weight_percent,
      created_at,
      last_modified_at
    FROM assessments
    WHERE class_id = $1
    ORDER BY weight_percent
  `,

  //
  // 3) POST /assessments
  //    → Create a new assessment
  //
  createAssessment: `
    INSERT INTO assessments (
      class_id,
      name,
      weight_percent
    ) VALUES ($1, $2, $3)
    RETURNING *
  `,

  //
  // (Optional) PATCH /assessments/:id
  //    → Update any field of an existing assessment
  //
  updateAssessmentById: `
    UPDATE assessments
    SET
      class_id        = COALESCE($1, class_id),
      name            = COALESCE($2, name),
      weight_percent  = COALESCE($3, weight_percent),
      last_modified_at = NOW()
    WHERE assessment_id = $4
    RETURNING *
  `,

  //
  // (Optional) DELETE /assessments/:id
  //    → Delete an assessment by its UUID
  //
  deleteAssessmentById: `
    DELETE FROM assessments
    WHERE assessment_id = $1
  `,

  selectFinalGradesByStudent: `
    SELECT 
      c.subject AS subject_name,
      ROUND(SUM(COALESCE(sa.score, 0) * (a.weight_percent / 100.0))) AS final_grade
    FROM students s
    JOIN class_students cs ON cs.student_id = s.student_id
    JOIN classes c ON c.class_id = cs.class_id
    JOIN assessments a ON a.class_id = c.class_id
    LEFT JOIN student_assessments sa 
      ON sa.assessment_id = a.assessment_id AND sa.student_id = s.student_id
    WHERE s.student_id = $1
    GROUP BY c.subject
    ORDER BY c.subject
  `
}

module.exports = assessmentQueries
