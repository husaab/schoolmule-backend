// queries/studentOverview.queries.js
//
// Reads behind the staff student profile (GET /api/students/:id/overview).
// A student row belongs to one school year (rollover makes a fresh row), so
// everything keyed by student_id is already that year's data; terms are
// scoped to the student's own school_year_id. Dates come back as
// 'YYYY-MM-DD' text so they never shift through a JS Date.

const studentOverviewQueries = {
  // $1 student_id
  selectStudent: `
    SELECT
      s.*,
      NULLIF(TRIM(CONCAT(hr.first_name, ' ', hr.last_name)), '') AS homeroom_teacher_name
    FROM students s
    LEFT JOIN users hr ON hr.user_id = s.homeroom_teacher_id
    WHERE s.student_id = $1
  `,

  // $1 school, $2 school_year_id|null
  selectTerms: `
    SELECT
      term_id,
      name,
      to_char(start_date, 'YYYY-MM-DD') AS start_date,
      to_char(end_date, 'YYYY-MM-DD')   AS end_date,
      is_active,
      school_year_id
    FROM terms
    WHERE school = $1 AND ($2::uuid IS NULL OR school_year_id = $2)
    ORDER BY start_date ASC
  `,

  // Every class the student is enrolled in, JK/SK included (the analytics
  // matrix skips those). $1 student_id, $2 school
  selectEnrollments: `
    SELECT
      c.class_id,
      c.subject,
      c.grade::text AS class_grade,
      c.teacher_id,
      c.teacher_name,
      c.term_id
    FROM class_students cs
    JOIN classes c ON c.class_id = cs.class_id
    LEFT JOIN terms t ON t.term_id = c.term_id
    WHERE cs.student_id = $1 AND c.school = $2
    ORDER BY t.start_date NULLS LAST, c.subject
  `,

  // $1 student_id, $2 school
  selectAttendanceDays: `
    SELECT to_char(attendance_date, 'YYYY-MM-DD') AS date, status::text AS status
    FROM general_attendance
    WHERE student_id = $1 AND school = $2
    ORDER BY attendance_date
  `,

  // Parent-portal links: a parent_id means a live account; no parent_id with
  // invited_at means an invite is still out. $1 student_id
  selectGuardianLinks: `
    SELECT
      ps.parent_student_link_id,
      ps.parent_id,
      ps.relation,
      COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), ps.parent_name) AS name,
      COALESCE(u.email, ps.parent_email) AS email,
      ps.parent_number AS phone,
      ps.invited_at
    FROM parent_students ps
    LEFT JOIN users u ON u.user_id = ps.parent_id
    WHERE ps.student_id = $1
    ORDER BY ps.relation NULLS LAST, name
  `,

  // $1 student_id, $2 school
  selectReportCards: `
    SELECT term, file_path, generated_at, email_sent, email_sent_at
    FROM report_cards
    WHERE student_id = $1 AND school = $2
    ORDER BY generated_at DESC
  `,

  // $1 student_id, $2 school
  selectProgressReports: `
    SELECT term, file_path, generated_at, email_sent, email_sent_at
    FROM progress_reports
    WHERE student_id = $1 AND school = $2
    ORDER BY generated_at DESC
  `,
};

module.exports = studentOverviewQueries;
