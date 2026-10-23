// queries/reportEmailRuns.queries.js
//
// Report card and progress report sends (report_email_runs) and what their
// queued emails read when they are sent (services/reportEmails.js).

// generated_at names the version: a regenerated report keeps its path.
const FILE_QUERY = (table) => `
    SELECT student_id, file_path, generated_at
    FROM ${table}
    WHERE student_id = ANY($1::uuid[]) AND term = $2 AND school = $3`;

const reportEmailRunsQueries = {
  // One send at a time per school, report and term, so two sends at once
  // can't both miss the other's emails. $1 key text
  lockSends: `SELECT pg_advisory_xact_lock(hashtext($1))`,

  // $1 school, $2 report_type, $3 term, $4 header, $5 message, $6 cc json, $7 recipients, $8 student count, $9 created_by
  insertRun: `
    INSERT INTO report_email_runs
      (school, report_type, term, custom_header, custom_message, cc_addresses, recipients, student_count, created_by)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
    RETURNING run_id, created_at`,

  // $1 run_id
  selectRun: `
    SELECT run_id, school::text AS school, report_type, term, custom_header, custom_message, cc_addresses,
           recipients, student_count, created_by, created_at
    FROM report_email_runs
    WHERE run_id = $1`,

  // A run of the caller's school. $1 run_id, $2 school
  selectRunInSchool: `
    SELECT run_id, school::text AS school, report_type, term, custom_header, custom_message, cc_addresses,
           recipients, student_count, created_by, created_at
    FROM report_email_runs
    WHERE run_id = $1 AND school = $2`,

  // The school's latest sends, newest first. $1 school, $2 report_type|null, $3 term|null, $4 limit
  selectRecentRuns: `
    SELECT r.run_id, r.report_type, r.term, r.recipients, r.student_count, r.created_at,
           NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS created_by_name
    FROM report_email_runs r
    LEFT JOIN users u ON u.user_id = r.created_by
    WHERE r.school = $1 AND ($2::text IS NULL OR r.report_type = $2) AND ($3::text IS NULL OR r.term = $3)
    ORDER BY r.created_at DESC
    LIMIT $4`,

  // Students to send to, in the caller's school. $1 student ids, $2 school
  selectStudents: `
    SELECT student_id, name, school::text AS school, mother_email, father_email
    FROM students
    WHERE student_id = ANY($1::uuid[]) AND is_archived = FALSE AND school = $2`,

  // One student as it is when the email is sent. $1 student_id
  selectStudent: `
    SELECT student_id, name, school::text AS school, mother_email, father_email, COALESCE(is_archived, FALSE) AS is_archived
    FROM students
    WHERE student_id = $1`,

  // The generated PDF per student. $1 student ids, $2 term, $3 school
  selectReportCardFiles: FILE_QUERY('report_cards'),
  selectProgressReportFiles: FILE_QUERY('progress_reports'),

  // Emails of the same report still waiting to go, from any send, so a second
  // click (or a second send while the first is going) never doubles one.
  // $1 school, $2 report_type, $3 term, $4 student ids
  selectPendingForStudents: `
    SELECT o.student_id, LOWER(o.recipient_email) AS email
    FROM email_outbox o
    JOIN report_email_runs r ON r.run_id = o.subject_id
    WHERE o.kind = 'report_email' AND o.subject_type = 'report_email_run' AND o.status = 'pending'
      AND r.school = $1 AND r.report_type = $2 AND r.term = $3 AND o.student_id = ANY($4::uuid[])`,

  // The emailed log the report card pages read: one row per student per send,
  // its addresses growing as each is sent.
  // $1 report_type, $2 student_id, $3 term, $4 sent_by, $5 address json, $6 header, $7 message,
  // $8 file_path, $9 cc json|null, $10 school, $11 run_id
  upsertReportEmail: `
    INSERT INTO report_emails
      (report_type, student_id, term, sent_by, email_addresses, custom_header, custom_message, file_path,
       cc_addresses, school, run_id)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10, $11)
    ON CONFLICT (run_id, student_id) WHERE run_id IS NOT NULL DO UPDATE
    SET email_addresses = (
          SELECT COALESCE(jsonb_agg(DISTINCT e.value), '[]'::jsonb)
          FROM jsonb_array_elements(COALESCE(report_emails.email_addresses, '[]'::jsonb) || EXCLUDED.email_addresses) AS e
        ),
        cc_addresses = COALESCE(report_emails.cc_addresses, EXCLUDED.cc_addresses),
        file_path = EXCLUDED.file_path,
        sent_at = NOW()`,
};

module.exports = reportEmailRunsQueries;
