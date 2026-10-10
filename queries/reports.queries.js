// Get school information
const getSchoolInfoByCode = `
  SELECT name, address, phone, email
  FROM schools
  WHERE school_code = $1
`;

// Get student information
const getStudentById = `
  SELECT student_id, name, grade, school
  FROM students
  WHERE student_id = $1
`;

// Get class information
const getClassInfo = `
  SELECT 
    c.class_id,
    c.subject,
    c.teacher_name,
    c.term_id,
    c.term_name,
    c.grade as class_grade
  FROM classes c
  WHERE c.class_id = $1
`;

// Get term information
const getTermById = `
  SELECT term_id, name, start_date, end_date, is_active
  FROM terms
  WHERE term_id = $1
`;

// Get all assessments for a class (including parent and child assessments)
const getAssessmentsByClass = `
  SELECT
    assessment_id,
    name,
    weight_percent,
    weight_points,
    max_score,
    date,
    created_at,
    sort_order,
    parent_assessment_id,
    is_parent
  FROM assessments
  WHERE class_id = $1
  ORDER BY
    CASE WHEN parent_assessment_id IS NULL THEN assessment_id ELSE parent_assessment_id END,
    parent_assessment_id NULLS FIRST,
    sort_order ASC,
    date ASC,
    name ASC
`;

// Get student's score row for EVERY assessment in the class (blank cells
// included), with the grading status. Drives from assessments, not from
// student_assessments, so a never-entered cell still appears as blank.
const getStudentAssessmentScores = `
  SELECT
    a.assessment_id,
    sa.score,
    a.max_score,
    a.weight_percent,
    a.weight_points,
    COALESCE(sa.status, 'graded') AS status,
    (COALESCE(sa.status, 'graded') = 'excused') AS is_excluded
  FROM assessments a
  LEFT JOIN student_assessments sa
    ON sa.assessment_id = a.assessment_id
   AND sa.student_id = $1
  WHERE a.class_id = $2
`;

// Verify student is enrolled in class
const verifyStudentEnrollment = `
  SELECT 1
  FROM class_students cs
  WHERE cs.student_id = $1 AND cs.class_id = $2
`;

module.exports = {
  getSchoolInfoByCode,
  getStudentById,
  getClassInfo,
  getTermById,
  getAssessmentsByClass,
  getStudentAssessmentScores,
  verifyStudentEnrollment
};