// Create a new report email record
const createReportEmail = `
  INSERT INTO report_emails (
    report_type,
    student_id,
    term,
    sent_by,
    email_addresses,
    custom_header,
    custom_message,
    file_path,
    cc_addresses,
    school
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  RETURNING *
`;

// Get all report emails for a student
const getReportEmailsByStudent = `
  SELECT 
    id,
    report_type,
    student_id,
    term,
    sent_by,
    email_addresses,
    custom_header,
    custom_message,
    file_path,
    sent_at,
    cc_addresses,
    school
  FROM report_emails
  WHERE student_id = $1
  ORDER BY sent_at DESC
`;

// Get report emails by term and school
const getReportEmailsByTermAndSchool = `
  SELECT 
    re.id,
    re.report_type,
    re.student_id,
    re.term,
    re.sent_by,
    re.email_addresses,
    re.custom_header,
    re.custom_message,
    re.file_path,
    re.sent_at,
    re.cc_addresses,
    re.school,
    s.name as student_name
  FROM report_emails re
  JOIN students s ON re.student_id = s.student_id
  WHERE re.term = $1 AND re.school = $2
  ORDER BY re.sent_at DESC
`;

// Get specific report email by ID
const getReportEmailById = `
  SELECT 
    id,
    report_type,
    student_id,
    term,
    sent_by,
    email_addresses,
    custom_header,
    custom_message,
    file_path,
    sent_at,
    cc_addresses,
    school
  FROM report_emails
  WHERE id = $1
`;

// Get report emails by report type and term
const getReportEmailsByTypeAndTerm = `
  SELECT 
    re.id,
    re.report_type,
    re.student_id,
    re.term,
    re.sent_by,
    re.email_addresses,
    re.custom_header,
    re.custom_message,
    re.file_path,
    re.sent_at,
    re.cc_addresses,
    re.school,
    s.name as student_name,
    u.username as sent_by_username
  FROM report_emails re
  JOIN students s ON re.student_id = s.student_id
  LEFT JOIN users u ON re.sent_by = u.user_id
  WHERE re.report_type = $1 AND re.term = $2
  ORDER BY re.sent_at DESC
`;

// Delete report email record
const deleteReportEmail = `
  DELETE FROM report_emails
  WHERE id = $1
  RETURNING *
`;

module.exports = {
  createReportEmail,
  getReportEmailsByStudent,
  getReportEmailsByTermAndSchool,
  getReportEmailById,
  getReportEmailsByTypeAndTerm,
  deleteReportEmail
};