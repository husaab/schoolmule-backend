// File: src/queries/excludedAssessment.queries.js
//
// Legacy "excluded assessments" API, now backed by student_assessments.status
// ('excused'). student_excluded_assessments is no longer read.
//
// Writes go through applyCellStatus, which never stores a row for a category:
// excusing a category id excuses each leaf child. So a category counts as
// excluded here when every one of its leaf children is excused, which keeps
// the check/list endpoints symmetric with POST for clients that send category ids.

// Leaf children of a category (or the leaf itself) that are excused for one
// student, compared against the total number of leaves under that id.
const LEAF_TARGETS = `
  FROM assessments t
  WHERE t.class_id = $2
    AND (t.assessment_id = $3 OR t.parent_assessment_id = $3)
    AND t.is_parent = FALSE
`;

// Categories where every leaf child is excused for a student. $1 = class_id;
// the optional student filter is spliced in by the caller.
const fullyExcusedCategories = (studentFilter) => `
  SELECT sa.student_id, p.class_id, p.assessment_id, p.name AS assessment_name, p.sort_order
  FROM assessments p
  JOIN assessments c ON c.parent_assessment_id = p.assessment_id AND c.is_parent = FALSE
  JOIN student_assessments sa ON sa.assessment_id = c.assessment_id ${studentFilter}
  WHERE p.class_id = $1 AND p.is_parent = TRUE
  GROUP BY sa.student_id, p.class_id, p.assessment_id, p.name, p.sort_order
  HAVING COUNT(*) FILTER (WHERE sa.status = 'excused')
       = (SELECT COUNT(*) FROM assessments t
          WHERE t.parent_assessment_id = p.assessment_id AND t.is_parent = FALSE)
`;

const excusedLeaves = (studentFilter) => `
  SELECT sa.student_id, a.class_id, a.assessment_id, a.name AS assessment_name, a.sort_order
  FROM student_assessments sa
  JOIN assessments a ON a.assessment_id = sa.assessment_id
  WHERE a.class_id = $1 AND sa.status = 'excused' ${studentFilter}
`;

const excludedAssessmentQueries = {
  // GET /excluded-assessments/:studentId/:classId   ($1 = classId, $2 = studentId)
  selectExclusionsByStudentAndClass: `
    SELECT student_id, class_id, assessment_id, assessment_name
    FROM (
      ${excusedLeaves('AND sa.student_id = $2')}
      UNION ALL
      ${fullyExcusedCategories('AND sa.student_id = $2')}
    ) x
    ORDER BY sort_order NULLS LAST, assessment_name
  `,

  // Is this assessment (leaf, or category with every leaf) excused for the student?
  // ($1 = studentId, $2 = classId, $3 = assessmentId)
  checkExclusion: `
    SELECT 1
    FROM student_assessments sa
    WHERE sa.student_id = $1
      AND sa.status = 'excused'
      AND sa.assessment_id IN (SELECT t.assessment_id ${LEAF_TARGETS})
    HAVING COUNT(*) > 0
       AND COUNT(*) = (SELECT COUNT(*) ${LEAF_TARGETS})
  `,

  // GET /excluded-assessments/class/:classId   ($1 = classId)
  selectExclusionsByClass: `
    SELECT student_id, class_id, assessment_id, assessment_name
    FROM (
      ${excusedLeaves('')}
      UNION ALL
      ${fullyExcusedCategories('')}
    ) x
    ORDER BY student_id, sort_order NULLS LAST, assessment_name
  `,
};

module.exports = excludedAssessmentQueries;
