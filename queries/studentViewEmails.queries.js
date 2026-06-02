// queries/studentViewEmails.queries.js
//
// SQL for the "Email Certificate to Parents" flow on Student Views.
// Logging mirrors report_emails (see queries/reportEmails.queries.js)
// but targets the student_view_emails table — see the migration.

const studentViewEmailsQueries = {
  // Parent-contact lookup for the selected students. The evaluator
  // (services/studentViewEvaluator.js) returns name/grade/metric but
  // NOT parent emails, so the controller fetches them here — same
  // source the bulk report-card flow uses (mother_email/father_email).
  selectStudentEmailsByIds: `
    SELECT student_id, name, grade::text AS grade, school,
           mother_email, father_email
    FROM public.students
    WHERE student_id = ANY($1)
      AND is_archived = false
  `,

  // One row per student per certificate send.
  createStudentViewCertificateEmail: `
    INSERT INTO public.student_view_emails
      (view_id, student_id, sent_by, email_addresses, cc_addresses,
       custom_header, custom_message, metric, school)
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
    RETURNING id, sent_at
  `,
};

module.exports = studentViewEmailsQueries;
