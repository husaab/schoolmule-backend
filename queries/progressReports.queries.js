// Get progress report feedback for a specific student and class
const getProgressReportFeedback = `
  SELECT 
    id,
    student_id,
    class_id,
    core_standards,
    work_habit,
    behavior,
    comment,
    created_at
  FROM progress_report_feedback
  WHERE student_id = $1 AND class_id = $2
`;

// Create new progress report feedback
const createProgressReportFeedback = `
  INSERT INTO progress_report_feedback (
    student_id,
    class_id,
    core_standards,
    work_habit,
    behavior,
    comment
  )
  VALUES ($1, $2, $3, $4, $5, $6)
  RETURNING *
`;

// Update existing progress report feedback
const updateProgressReportFeedback = `
  UPDATE progress_report_feedback
  SET 
    core_standards = $1,
    work_habit = $2,
    behavior = $3,
    comment = $4,
    created_at = NOW()
  WHERE student_id = $5 AND class_id = $6
  RETURNING *
`;

// Get all progress report feedback for a student across all classes
const getStudentProgressReportFeedback = `
  SELECT 
    prf.id,
    prf.student_id,
    prf.class_id,
    prf.core_standards,
    prf.work_habit,
    prf.behavior,
    prf.comment,
    prf.created_at,
    c.subject,
    c.grade as class_grade,
    c.teacher_name
  FROM progress_report_feedback prf
  JOIN classes c ON prf.class_id = c.class_id
  WHERE prf.student_id = $1
  ORDER BY c.subject ASC
`;

// Get all progress report feedback for a class
const getClassProgressReportFeedback = `
  SELECT 
    prf.id,
    prf.student_id,
    prf.class_id,
    prf.core_standards,
    prf.work_habit,
    prf.behavior,
    prf.comment,
    prf.created_at,
    s.name as student_name,
    s.grade as student_grade
  FROM progress_report_feedback prf
  JOIN students s ON prf.student_id = s.student_id
  WHERE prf.class_id = $1
  ORDER BY s.name ASC
`;

// Delete progress report feedback
const deleteProgressReportFeedback = `
  DELETE FROM progress_report_feedback
  WHERE student_id = $1 AND class_id = $2
`;

// Create progress report record
const createProgressReport = `
  INSERT INTO progress_reports (
    student_id,
    term,
    student_name,
    grade,
    file_path,
    school
  )
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (student_id, term)
  DO UPDATE SET
    student_name = EXCLUDED.student_name,
    grade = EXCLUDED.grade,
    file_path = EXCLUDED.file_path,
    school = EXCLUDED.school,
    generated_at = NOW()
  RETURNING *
`;

// Get all progress reports for a student
const getStudentProgressReports = `
  SELECT 
    student_id,
    term,
    student_name,
    grade,
    file_path,
    generated_at,
    school,
    email_sent,
    email_sent_at,
    email_sent_by
  FROM progress_reports
  WHERE student_id = $1
  ORDER BY generated_at DESC
`;

// Get progress reports by term and school
const getProgressReportsByTermAndSchool = `
  SELECT 
    student_id,
    term,
    student_name,
    grade,
    file_path,
    generated_at,
    school,
    email_sent,
    email_sent_at,
    email_sent_by
  FROM progress_reports
  WHERE term = $1 AND school = $2
  ORDER BY student_name ASC
`;

// Get progress report by student and term
const getProgressReportByStudentAndTerm = `
  SELECT 
    student_id,
    term,
    student_name,
    grade,
    file_path,
    generated_at,
    school,
    email_sent,
    email_sent_at,
    email_sent_by
  FROM progress_reports
  WHERE student_id = $1 AND term = $2
`;

// Update email status for progress report
const updateProgressReportEmailStatus = `
  UPDATE progress_reports
  SET 
    email_sent = $3,
    email_sent_at = $4,
    email_sent_by = $5
  WHERE student_id = $1 AND term = $2
  RETURNING *
`;

module.exports = {
  getProgressReportFeedback,
  createProgressReportFeedback,
  updateProgressReportFeedback,
  getStudentProgressReportFeedback,
  getClassProgressReportFeedback,
  deleteProgressReportFeedback,
  createProgressReport,
  getStudentProgressReports,
  getProgressReportsByTermAndSchool,
  getProgressReportByStudentAndTerm,
  updateProgressReportEmailStatus
};