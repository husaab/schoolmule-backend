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

// Get student's assessment scores with exclusion status
const getStudentAssessmentScores = `
  SELECT
    sa.assessment_id,
    sa.score,
    a.max_score,
    a.weight_percent,
    a.weight_points,
    CASE WHEN sea.assessment_id IS NOT NULL THEN true ELSE false END as is_excluded
  FROM student_assessments sa
  JOIN assessments a ON sa.assessment_id = a.assessment_id
  LEFT JOIN student_excluded_assessments sea
    ON sea.student_id = sa.student_id
    AND sea.class_id = a.class_id
    AND sea.assessment_id = a.assessment_id
  WHERE sa.student_id = $1
    AND a.class_id = $2
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