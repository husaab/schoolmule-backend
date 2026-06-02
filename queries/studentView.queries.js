// queries/studentView.queries.js
//
// All raw SQL needed by the Student Views feature.
//
// Two flavors of query live here:
//   1. CRUD on the `student_views` table itself.
//   2. Read-only queries the evaluator uses to pull the data
//      (classes, assessments, scores, attendance) it needs to
//      decide which students qualify for a view.

const studentViewQueries = {
  // ────────────────────────────────────────────────────────
  // CRUD on student_views
  // ────────────────────────────────────────────────────────

  // Lists every view visible to one user at one school:
  //   - their own (any privacy)
  //   - shared by others
  //   - system-seeded
  selectVisibleViews: `
    SELECT view_id, school, owner_user_id, name, description,
           is_shared, is_system, criteria, created_at, updated_at
    FROM public.student_views
    WHERE school = $1
      AND (owner_user_id = $2 OR is_shared = TRUE OR is_system = TRUE)
    ORDER BY is_system DESC, name ASC
  `,

  selectViewById: `
    SELECT view_id, school, owner_user_id, name, description,
           is_shared, is_system, criteria, created_at, updated_at
    FROM public.student_views
    WHERE view_id = $1
  `,

  // When inserting a system view, pass owner_user_id = NULL and is_system = TRUE.
  // The CHECK constraint on the table enforces the (is_system, owner_user_id)
  // invariant — see the migration.
  insertView: `
    INSERT INTO public.student_views
      (school, owner_user_id, name, description, is_shared, is_system, criteria)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    RETURNING view_id, school, owner_user_id, name, description,
              is_shared, is_system, criteria, created_at, updated_at
  `,

  // System-view editability is enforced in the controller (admin-only).
  // SQL accepts the update for any non-deleted view and lets the caller decide.
  // $6 (is_system) and $7 (owner_user_id) are admin-only flip semantics handled
  // upstream; COALESCE keeps them no-op for the common rename/criteria-edit path.
  updateView: `
    UPDATE public.student_views
       SET name          = COALESCE($2, name),
           description   = COALESCE($3, description),
           is_shared     = COALESCE($4, is_shared),
           criteria      = COALESCE($5::jsonb, criteria),
           is_system     = COALESCE($6, is_system),
           owner_user_id = CASE
             WHEN $8::boolean = TRUE THEN $7
             ELSE owner_user_id
           END
     WHERE view_id = $1
    RETURNING view_id, school, owner_user_id, name, description,
              is_shared, is_system, criteria, created_at, updated_at
  `,

  deleteView: `
    DELETE FROM public.student_views
     WHERE view_id = $1
       AND is_system = FALSE
    RETURNING view_id
  `,

  // ────────────────────────────────────────────────────────
  // Reads the evaluator depends on
  // ────────────────────────────────────────────────────────

  // Terms for a school, ordered chronologically — used to resolve
  // the "FIRST_TWO_TERMS" marker on the seeded "Both Terms" view
  // and to find the active term.
  selectTermsBySchool: `
    SELECT term_id, name, start_date, end_date, is_active
    FROM public.terms
    WHERE school = $1
    ORDER BY start_date ASC NULLS LAST, name ASC
  `,

  // Classes in a school for a given term, with optional grade/subject filtering.
  // `gradeLevels` and `subjects` are passed as Postgres arrays; an empty array
  // means "no filter on that dimension".
  selectClassesForEvaluation: `
    SELECT class_id, grade::text AS grade, subject, term_id, term_name
    FROM public.classes
    WHERE school = $1
      AND term_id = $2
      AND grade NOT IN ('JK', 'SK')
      AND (COALESCE(array_length($3::text[], 1), 0) = 0 OR grade::text = ANY($3::text[]))
      AND (COALESCE(array_length($4::text[], 1), 0) = 0 OR subject = ANY($4::text[]))
  `,

  // All assessment + score rows for one class. Same shape that
  // utils/gradeCalculator.js consumes via calculateBulkGrades.
  selectScoresForClass: `
    SELECT
      cs.student_id,
      s.name             AS student_name,
      s.grade::text      AS student_grade,
      s.homeroom_teacher_id,
      a.assessment_id,
      a.name             AS assessment_name,
      a.weight_percent,
      a.weight_points,
      a.max_score,
      a.is_parent,
      a.parent_assessment_id,
      sa.score,
      CASE WHEN sea.assessment_id IS NOT NULL THEN TRUE ELSE FALSE END AS is_excluded
    FROM class_students AS cs
    JOIN students AS s
      ON cs.student_id = s.student_id
    JOIN assessments AS a
      ON a.class_id = cs.class_id
    LEFT JOIN student_assessments AS sa
      ON sa.student_id   = cs.student_id
     AND sa.assessment_id = a.assessment_id
    LEFT JOIN student_excluded_assessments sea
      ON sea.student_id   = cs.student_id
     AND sea.class_id     = cs.class_id
     AND sea.assessment_id = a.assessment_id
    WHERE cs.class_id = $1
  `,

  // Per-student attendance percentage over the term window
  // (present-or-late counted as "in attendance"). Used only when
  // criteria.attendanceMinPercent is set.
  selectAttendancePctForTerm: `
    SELECT
      ga.student_id,
      COUNT(*) FILTER (WHERE ga.status IN ('present', 'late')) * 100.0
        / NULLIF(COUNT(*), 0) AS attendance_pct
    FROM general_attendance ga
    JOIN terms t
      ON t.term_id = $1
    WHERE ga.school = $2
      AND ga.attendance_date BETWEEN t.start_date AND t.end_date
    GROUP BY ga.student_id
  `,
};

module.exports = studentViewQueries;
