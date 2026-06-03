// queries/analytics.queries.js
//
// All raw SQL for the teacher analytics feature.
//
// The core idea: ONE school-wide query (selectAnalyticsMatrix) returns a
// row per (class, student, assessment) for a term. The analytics engine
// groups it in JS and runs the chosen grade engine per (student, class).
// At current scale (~190 students x ~10 assessments) this is <30k rows —
// a single fast round-trip, no N+1 per class.

const analyticsQueries = {
  /**
   * The full score matrix for a school + term.
   * Shape mirrors studentView.queries selectScoresForClass, plus class meta
   * (subject, grade, teacher) and assessment date/sort for trend charts.
   * Params: $1 school, $2 term_id
   */
  selectAnalyticsMatrix: `
    SELECT
      c.class_id,
      c.grade::text           AS class_grade,
      c.subject,
      c.teacher_name,
      c.term_id,
      cs.student_id,
      s.name                  AS student_name,
      s.grade::text           AS student_grade,
      s.homeroom_teacher_id,
      a.assessment_id,
      a.name                  AS assessment_name,
      a.weight_percent,
      a.weight_points,
      a.max_score,
      a.is_parent,
      a.parent_assessment_id,
      a.date                  AS assessment_date,
      a.sort_order,
      sa.score,
      CASE WHEN sea.assessment_id IS NOT NULL THEN TRUE ELSE FALSE END AS is_excluded
    FROM class_students AS cs
    JOIN classes AS c
      ON c.class_id = cs.class_id
    JOIN students AS s
      ON s.student_id = cs.student_id
     AND s.is_archived = FALSE
    JOIN assessments AS a
      ON a.class_id = c.class_id
    LEFT JOIN student_assessments AS sa
      ON sa.student_id    = cs.student_id
     AND sa.assessment_id = a.assessment_id
    LEFT JOIN student_excluded_assessments AS sea
      ON sea.student_id    = cs.student_id
     AND sea.class_id      = cs.class_id
     AND sea.assessment_id = a.assessment_id
    WHERE c.school  = $1
      AND c.term_id = $2
      AND c.grade NOT IN ('JK', 'SK')
    ORDER BY c.class_id, cs.student_id, a.sort_order NULLS LAST, a.date NULLS LAST
  `,

  /**
   * Same matrix across ALL terms of a school (termId='all' on the API).
   * Classes are term-bound, so this is simply the union of every term's
   * classes; the engine merges them into one combined view.
   * Params: $1 school
   */
  selectAnalyticsMatrixAllTerms: `
    SELECT
      c.class_id,
      c.grade::text           AS class_grade,
      c.subject,
      c.teacher_name,
      c.term_id,
      cs.student_id,
      s.name                  AS student_name,
      s.grade::text           AS student_grade,
      s.homeroom_teacher_id,
      a.assessment_id,
      a.name                  AS assessment_name,
      a.weight_percent,
      a.weight_points,
      a.max_score,
      a.is_parent,
      a.parent_assessment_id,
      a.date                  AS assessment_date,
      a.sort_order,
      sa.score,
      CASE WHEN sea.assessment_id IS NOT NULL THEN TRUE ELSE FALSE END AS is_excluded
    FROM class_students AS cs
    JOIN classes AS c
      ON c.class_id = cs.class_id
    JOIN students AS s
      ON s.student_id = cs.student_id
     AND s.is_archived = FALSE
    JOIN assessments AS a
      ON a.class_id = c.class_id
    LEFT JOIN student_assessments AS sa
      ON sa.student_id    = cs.student_id
     AND sa.assessment_id = a.assessment_id
    LEFT JOIN student_excluded_assessments AS sea
      ON sea.student_id    = cs.student_id
     AND sea.class_id      = cs.class_id
     AND sea.assessment_id = a.assessment_id
    WHERE c.school  = $1
      AND c.grade NOT IN ('JK', 'SK')
    ORDER BY c.class_id, cs.student_id, a.sort_order NULLS LAST, a.date NULLS LAST
  `,

  /**
   * Per-student attendance over a term's date window.
   * NOTE: status enum values are UPPERCASE ('PRESENT','LATE','ABSENT') —
   * verified against the live database.
   * Params: $1 term_id, $2 school
   */
  selectAttendanceForTerm: `
    SELECT
      ga.student_id,
      COUNT(*) FILTER (WHERE ga.status IN ('PRESENT', 'LATE'))::int AS present_days,
      COUNT(*)::int AS total_days,
      ROUND(
        COUNT(*) FILTER (WHERE ga.status IN ('PRESENT', 'LATE')) * 100.0
          / NULLIF(COUNT(*), 0),
        1
      ) AS attendance_pct
    FROM general_attendance ga
    JOIN terms t
      ON t.term_id = $1
    WHERE ga.school = $2
      AND ga.attendance_date BETWEEN t.start_date AND t.end_date
    GROUP BY ga.student_id
  `,

  /**
   * Per-student attendance across ALL terms of a school (union of every
   * term's date window — gaps between terms don't count).
   * Params: $1 school
   */
  selectAttendanceAllTerms: `
    SELECT
      ga.student_id,
      COUNT(*) FILTER (WHERE ga.status IN ('PRESENT', 'LATE'))::int AS present_days,
      COUNT(*)::int AS total_days,
      ROUND(
        COUNT(*) FILTER (WHERE ga.status IN ('PRESENT', 'LATE')) * 100.0
          / NULLIF(COUNT(*), 0),
        1
      ) AS attendance_pct
    FROM general_attendance ga
    WHERE ga.school = $1
      AND EXISTS (
        SELECT 1 FROM terms t
        WHERE t.school = $1
          AND ga.attendance_date BETWEEN t.start_date AND t.end_date
      )
    GROUP BY ga.student_id
  `,

  /**
   * Resolve a class's term (used when /class/:classId is called without termId).
   * Params: $1 class_id, $2 school
   */
  selectTermIdForClass: `
    SELECT term_id, subject, grade::text AS grade, teacher_name
    FROM classes
    WHERE class_id = $1 AND school = $2
    LIMIT 1
  `,

  /**
   * Terms for a school, chronological. Reused for compare-term labels.
   * Params: $1 school
   */
  selectTermsBySchool: `
    SELECT term_id, name, start_date, end_date, is_active, academic_year
    FROM terms
    WHERE school = $1
    ORDER BY start_date ASC NULLS LAST, name ASC
  `,
};

module.exports = analyticsQueries;
