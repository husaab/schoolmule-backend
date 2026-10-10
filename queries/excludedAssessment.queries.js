// File: src/queries/excludedAssessment.queries.js
//
// Legacy "excluded assessments" API, now backed by student_assessments.status
// ('excused'). student_excluded_assessments is no longer read.

const excludedAssessmentQueries = {
  // GET /excluded-assessments/:studentId/:classId
  selectExclusionsByStudentAndClass: `
    SELECT sa.student_id, a.class_id, sa.assessment_id, a.name AS assessment_name
    FROM student_assessments sa
    JOIN assessments a ON a.assessment_id = sa.assessment_id
    WHERE sa.student_id = $1 AND a.class_id = $2 AND sa.status = 'excused'
    ORDER BY a.sort_order NULLS LAST, a.name
  `,

  // Check if specific assessment is excused for student in class
  checkExclusion: `
    SELECT 1
    FROM student_assessments sa
    JOIN assessments a ON a.assessment_id = sa.assessment_id
    WHERE sa.student_id = $1 AND a.class_id = $2 AND sa.assessment_id = $3 AND sa.status = 'excused'
  `,

  // GET /excluded-assessments/class/:classId
  selectExclusionsByClass: `
    SELECT sa.student_id, a.class_id, sa.assessment_id, a.name AS assessment_name
    FROM student_assessments sa
    JOIN assessments a ON a.assessment_id = sa.assessment_id
    WHERE a.class_id = $1 AND sa.status = 'excused'
    ORDER BY sa.student_id, a.sort_order NULLS LAST
  `,
};

module.exports = excludedAssessmentQueries;
