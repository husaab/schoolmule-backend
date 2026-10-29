// queries/analytics.queries.js
//
// All raw SQL for the teacher analytics feature.
//
// The core idea: the analytics matrix is a row per (class, student,
// assessment) for a set of classes (a school's term, every term, one class,
// or the classes a few students sit in). The analytics engine groups it in JS
// and runs the grade engine per (student, class).
//
// The matrix is read narrow (services/analyticsMatrix.js): each class,
// assessment, enrollment and score comes back once, and the loader joins
// them into those rows. One wide query repeated every name and comment on
// every cell, about 4–5 MB a school, and was read again every time the
// cache was cleared (the October 2026 Supabase egress overrun).

const { CLASS_TEACHER_NAME } = require('./personName');

/**
 * The class sets a matrix is read for: a WHERE fragment over `c` (classes)
 * and its params. JK/SK classes never enter the matrix (their own engine).
 *   term      $1 school, $2 term_id
 *   allTerms  $1 school (every term, every year)
 *   class     $1 class_id (any term)
 *   students  $1 school, $2 term_id or NULL for every term, $3 student_id[]:
 *             every class one of the students sits in, with all its students,
 *             so a child's class averages match the school-wide matrix
 */
const MATRIX_SCOPES = {
  term: 'c.school = $1 AND c.term_id = $2',
  allTerms: 'c.school = $1',
  class: 'c.class_id = $1',
  students: `c.school = $1
      AND ($2::uuid IS NULL OR c.term_id = $2)
      AND EXISTS (
        SELECT 1 FROM class_students AS mine
        WHERE mine.class_id = c.class_id AND mine.student_id = ANY($3::uuid[])
      )`,
};

const inScope = (scope) => `${MATRIX_SCOPES[scope]}
      AND c.grade NOT IN ('JK', 'SK')`;

/** One SQL string per scope: { term, allTerms, class, students }. */
const perScope = (build) =>
  Object.fromEntries(Object.keys(MATRIX_SCOPES).map((scope) => [scope, build(inScope(scope))]));

const analyticsQueries = {
  /** The matrix's classes, with the class details every row carries. */
  selectMatrixClasses: perScope((where) => `
    SELECT
      c.class_id,
      c.grade::text           AS class_grade,
      c.subject,
      ${CLASS_TEACHER_NAME('c', 'ctn')} AS teacher_name,
      c.show_class_average,
      c.term_id
    FROM classes AS c
    LEFT JOIN users AS ctn
      ON ctn.user_id = c.teacher_id
    WHERE ${where}
  `),

  /**
   * Every assessment of the matrix's classes, in the order a student's rows
   * run (sort order, then date, then creation, so ties read the same way
   * every time).
   */
  selectMatrixAssessments: perScope((where) => `
    SELECT
      a.class_id,
      a.assessment_id,
      a.name                  AS assessment_name,
      a.weight_percent,
      a.weight_points,
      a.max_score,
      a.is_parent,
      a.parent_assessment_id,
      TO_CHAR(a.date, 'YYYY-MM-DD') AS assessment_date,
      a.sort_order,
      a.is_published,
      a.parent_comment,
      a.published_at,
      -- An assignment or quiz fills the column (at most one item per column):
      -- its grades can be published one student at a time (spec D3).
      (ti.item_id IS NOT NULL) AS is_turn_in
    FROM classes AS c
    JOIN assessments AS a
      ON a.class_id = c.class_id
    LEFT JOIN classwork_items AS ti
      ON ti.assessment_id = a.assessment_id
     AND ti.kind IN ('assignment', 'quiz')
     AND ti.deleted_at IS NULL
    WHERE ${where}
    ORDER BY a.class_id, a.sort_order NULLS LAST, a.date NULLS LAST, a.created_at, a.assessment_id
  `),

  /**
   * Who sits in each class (archived students never count), and whether the
   * teacher left them out of the class's statistics (services/classStats.js).
   * The students' own details come from selectMatrixStudents.
   */
  selectMatrixEnrollments: perScope((where) => `
    SELECT
      cs.class_id,
      cs.student_id,
      (xc.exclusion_id IS NOT NULL) AS stats_left_out_class
    FROM classes AS c
    JOIN class_students AS cs
      ON cs.class_id = c.class_id
    JOIN students AS s
      ON s.student_id = cs.student_id
     AND s.is_archived = FALSE
    LEFT JOIN class_stats_exclusions AS xc
      ON xc.class_id   = cs.class_id
     AND xc.student_id = cs.student_id
     AND xc.assessment_id IS NULL
    WHERE ${where}
    ORDER BY cs.class_id, cs.student_id
  `),

  /** The enrolled students, once each. */
  selectMatrixStudents: perScope((where) => `
    SELECT DISTINCT
      s.student_id,
      s.name                  AS student_name,
      s.grade::text           AS student_grade,
      s.homeroom_teacher_id
    FROM classes AS c
    JOIN class_students AS cs
      ON cs.class_id = c.class_id
    JOIN students AS s
      ON s.student_id = cs.student_id
     AND s.is_archived = FALSE
    WHERE ${where}
  `),

  /**
   * The cells with a student_assessments row. A cell without one is blank:
   * no score, status 'graded'.
   */
  selectMatrixScores: perScope((where) => `
    SELECT
      sa.student_id,
      sa.assessment_id,
      sa.score,
      sa.status
    FROM classes AS c
    JOIN class_students AS cs
      ON cs.class_id = c.class_id
    JOIN students AS s
      ON s.student_id = cs.student_id
     AND s.is_archived = FALSE
    JOIN assessments AS a
      ON a.class_id = c.class_id
    JOIN student_assessments AS sa
      ON sa.student_id    = cs.student_id
     AND sa.assessment_id = a.assessment_id
    WHERE ${where}
  `),

  /** Cells a teacher left out of one assessment's statistics. */
  selectMatrixLeftOutCells: perScope((where) => `
    SELECT
      xa.class_id,
      xa.student_id,
      xa.assessment_id
    FROM classes AS c
    JOIN class_stats_exclusions AS xa
      ON xa.class_id = c.class_id
     AND xa.assessment_id IS NOT NULL
    WHERE ${where}
  `),

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

  /**
   * Classes a teacher owns or co-teaches (same rule as requireClassOwnership).
   * Params: $1 teacher user id
   */
  selectClassIdsForTeacher: `
    SELECT c.class_id FROM classes AS c WHERE c.teacher_id = $1
    UNION
    SELECT ct.class_id FROM class_teachers AS ct WHERE ct.teacher_id = $1
  `,
};

module.exports = analyticsQueries;
