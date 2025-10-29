// File: src/queries/excludedAssessment.queries.js

const excludedAssessmentQueries = {
  //
  // 1) POST /excluded-assessments
  //  Create a new exclusion record
  //
  createExclusion: `
    INSERT INTO student_excluded_assessments (
      student_id,
      class_id,
      assessment_id
    ) VALUES ($1, $2, $3)
    ON CONFLICT (student_id, class_id, assessment_id) DO NOTHING
    RETURNING *
  `,

  //
  // 2) DELETE /excluded-assessments/:studentId/:classId/:assessmentId
  //Remove an exclusion record
  //
  deleteExclusion: `
    DELETE FROM student_excluded_assessments
    WHERE student_id = $1 
      AND class_id = $2 
      AND assessment_id = $3
  `,

  //
  // 3) GET /excluded-assessments/:studentId/:classId
  // Get all excluded assessments for a student in a specific class
  //
  selectExclusionsByStudentAndClass: `
    SELECT
      student_id,
      class_id,
      assessment_id,
      created_at
    FROM student_excluded_assessments
    WHERE student_id = $1 AND class_id = $2
    ORDER BY created_at DESC
  `,

  //
  // 4) Check if specific assessment is excluded for student in class
  //
  checkExclusion: `
    SELECT 1
    FROM student_excluded_assessments
    WHERE student_id = $1 
      AND class_id = $2 
      AND assessment_id = $3
  `,

  //
  // 5) GET /excluded-assessments/class/:classId
  // Get all excluded assessments for an entire class
  //
  selectExclusionsByClass: `
    SELECT
      student_id,
      class_id,
      assessment_id,
      created_at
    FROM student_excluded_assessments
    WHERE class_id = $1
    ORDER BY student_id, created_at DESC
  `
}

module.exports = excludedAssessmentQueries