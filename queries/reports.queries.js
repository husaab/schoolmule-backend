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
    (COALESCE(sa.status, 'graded') = 'excused') AS is_excluded,
    (mm.student_id IS NOT NULL) AS is_modified,
    mm.label AS modified_label
  FROM assessments a
  LEFT JOIN student_assessments sa
    ON sa.assessment_id = a.assessment_id
   AND sa.student_id = $1
  LEFT JOIN modified_marks mm
    ON mm.assessment_id = a.assessment_id
   AND mm.student_id = $1
  WHERE a.class_id = $2
`;

// Verify student is enrolled in class
const verifyStudentEnrollment = `
  SELECT 1
  FROM class_students cs
  WHERE cs.student_id = $1 AND cs.class_id = $2
`;

// A term in the caller's school. $1 term id, $2 school
const getTermInSchool = `
  SELECT term_id, name, start_date, end_date, is_active
  FROM terms
  WHERE term_id = $1 AND school = $2
`;

// Every class a student is in for one term, with what the class rule needs
// (school, lead teacher, whether the caller co-teaches it).
// $1 student id, $2 term id, $3 caller's user id
const getStudentClassesForTerm = `
  SELECT
    c.class_id,
    c.subject,
    c.teacher_name,
    c.teacher_id,
    c.school,
    c.term_id,
    c.term_name,
    c.grade AS class_grade,
    EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $3) AS is_co_teacher
  FROM class_students cs
  JOIN classes c ON c.class_id = cs.class_id
  WHERE cs.student_id = $1 AND c.term_id = $2
  ORDER BY c.subject, c.class_id
`;

// getAssessmentsByClass for many classes at once (same order within a class).
const getAssessmentsByClasses = `
  SELECT
    class_id,
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
  WHERE class_id = ANY($1::uuid[])
  ORDER BY
    class_id,
    CASE WHEN parent_assessment_id IS NULL THEN assessment_id ELSE parent_assessment_id END,
    parent_assessment_id NULLS FIRST,
    sort_order ASC,
    date ASC,
    name ASC
`;

// getStudentAssessmentScores for many classes at once. $1 student, $2 class ids
const getStudentAssessmentScoresByClasses = `
  SELECT
    a.class_id,
    a.assessment_id,
    sa.score,
    a.max_score,
    a.weight_percent,
    a.weight_points,
    COALESCE(sa.status, 'graded') AS status,
    (COALESCE(sa.status, 'graded') = 'excused') AS is_excluded,
    (mm.student_id IS NOT NULL) AS is_modified,
    mm.label AS modified_label
  FROM assessments a
  LEFT JOIN student_assessments sa
    ON sa.assessment_id = a.assessment_id
   AND sa.student_id = $1
  LEFT JOIN modified_marks mm
    ON mm.assessment_id = a.assessment_id
   AND mm.student_id = $1
  WHERE a.class_id = ANY($2::uuid[])
`;

module.exports = {
  getTermInSchool,
  getStudentClassesForTerm,
  getAssessmentsByClasses,
  getStudentAssessmentScoresByClasses,
  getSchoolInfoByCode,
  getStudentById,
  getClassInfo,
  getTermById,
  getAssessmentsByClass,
  getStudentAssessmentScores,
  verifyStudentEnrollment
};