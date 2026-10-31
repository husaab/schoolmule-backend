// queries/reportEngineData.queries.js
//
// SQL the ReportData assembler (services/reportEngine/data) needs that only
// existed inline in the legacy report controllers. Each one is the legacy
// statement unchanged (the source is noted), so the assembler reads exactly
// what the old generators read. Shared statements (student, terms, feedback,
// JK/SK) are imported from their own query files instead.

const reportEngineDataQueries = {
  // reportCard.controller.js:608, progressReports.controller.js:431,
  // jk.controller.js:528, sk.controller.js:470. Params: $1 user_id
  selectHomeroomTeacherName: `
    SELECT username FROM users WHERE user_id = $1
  `,

  // Same COUNT every legacy generator runs. Params: $1 student_id
  countDaysAbsent: `
    SELECT COUNT(*) as days_absent
    FROM general_attendance
    WHERE student_id = $1 AND status = 'ABSENT'
  `,

  // jk.controller.js:50 (fetchSchoolData), plus timezone for the report date.
  // Params: $1 school_code (normalised)
  selectSchoolByCode: `
    SELECT school_id, name, address, phone, email, timezone
    FROM schools WHERE school_code = $1
  `,

  // The school year a report date falls in, else the active one, else the
  // latest. Params: $1 school (enum), $2 report date (YYYY-MM-DD)
  selectSchoolYearForDate: `
    SELECT school_year_id, label, start_date::text AS start_date, end_date::text AS end_date
    FROM school_years
    WHERE school = $1
    ORDER BY ($2::date BETWEEN start_date AND end_date) DESC, is_active DESC, start_date DESC
    LIMIT 1
  `,

  // Every class the student is enrolled in, any term
  // (reportCard.controller.js:36 and :688). Params: $1 student_id
  selectStudentClasses: `
    SELECT c.class_id, c.subject
    FROM class_students cs
    JOIN classes c ON cs.class_id = c.class_id
    WHERE cs.student_id = $1
  `,

  // reportCard.controller.js:52. Params: $1 class_id
  selectClassAssessments: `
    SELECT
      assessment_id,
      name,
      weight_points,
      max_score,
      is_parent,
      parent_assessment_id
    FROM assessments
    WHERE class_id = $1
  `,

  // reportCard.controller.js:67 — one row per assessment, blank cells too.
  // Params: $1 student_id, $2 class_id
  selectStudentClassScores: `
    SELECT
      a.assessment_id,
      sa.score,
      COALESCE(sa.status, 'graded') AS status,
    (COALESCE(sa.status, 'graded') = 'excused') AS is_excluded
    FROM assessments a
    LEFT JOIN student_assessments sa
      ON sa.assessment_id = a.assessment_id
      AND sa.student_id = $1
    WHERE a.class_id = $2
  `,

  // progressReports.controller.js:448 — the term's classes only.
  // Params: $1 student_id, $2 term_id
  selectStudentClassesForProgressTerm: `
    SELECT c.class_id, c.subject, c.teacher_name, c.grade as class_grade
    FROM class_students cs
    JOIN classes c ON cs.class_id = c.class_id
    WHERE cs.student_id = $1
      AND c.term_id = $2
    ORDER BY c.subject
  `,
};

module.exports = reportEngineDataQueries;
