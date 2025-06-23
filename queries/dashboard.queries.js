// src/queries/dashboardQueries.js

const dashboardQueries = {
  /**
   * Total Students: count of students in the given school
   * Params: school (public.school enum)
   */
  selectTotalStudents: `
    SELECT COUNT(*)::int AS count
    FROM students
    WHERE school = $1
  `,

  /**
   * Total Teachers: count of approved teachers in the given school
   * Params: school (public.school enum)
   */
  selectTotalTeachers: `
    SELECT COUNT(*)::int AS count
    FROM users
    WHERE role = 'TEACHER'
      AND school = $1
      AND is_verified = TRUE
      AND is_verified_school = TRUE
  `,

  /**
   * Total Classes: count of classes in the given school
   * Params: school (public.school enum)
   */
  selectTotalClasses: `
    SELECT COUNT(*)::int AS count
    FROM classes
    WHERE school = $1
  `,

  /**
   * Today's Attendance Rate: simple ratio of students marked PRESENT or LATE on a given date to total students
   * Params: school (public.school enum), date (date)
   */
  selectTodaysAttendanceRate: `
    SELECT
      CASE WHEN t.total_count = 0 THEN 0
           ELSE p.present_count::float / t.total_count
      END AS rate
    FROM (
      SELECT COUNT(*)::int AS total_count
      FROM students
      WHERE school = $1
    ) AS t,
    (
      SELECT COUNT(*)::int AS present_count
      FROM general_attendance ga
      JOIN students s ON ga.student_id = s.student_id
      WHERE ga.attendance_date = $2::date
        AND ga.status IN ('PRESENT','LATE')
        AND s.school = $1
    ) AS p
  `,

  selectAverageClassSize: `
    SELECT ROUND(AVG(student_count)::numeric, 1) AS avg_class_size
    FROM (
        SELECT COUNT(cs.student_id)::int AS student_count
        FROM class_students cs
        JOIN classes c
        ON cs.class_id = c.class_id
        WHERE c.school = $1
        GROUP BY cs.class_id
    ) AS sub
    `,

  /**
   * Weekly Attendance Rate: ratio of distinct students present/late over the 7 days ending on a given date to total students
   * Params: school (public.school enum), endDate (date)
   */
  selectWeeklyAttendanceRate: `
    SELECT
      CASE WHEN t.total_count = 0 THEN 0
           ELSE p.present_count::float / t.total_count
      END AS rate
    FROM (
      SELECT COUNT(*)::int AS total_count
      FROM students
      WHERE school = $1
    ) AS t,
    (
      SELECT COUNT(DISTINCT ga.student_id)::int AS present_count
      FROM general_attendance ga
      JOIN students s ON ga.student_id = s.student_id
      WHERE ga.attendance_date BETWEEN ($2::date - INTERVAL '6 days') AND $2::date
        AND ga.status IN ('PRESENT','LATE')
        AND s.school = $1
    ) AS p
  `,

  /**
   * Monthly Attendance Rate: ratio of distinct students present/late since the start of the month of a given date to total students
   * Params: school (public.school enum), referenceDate (date)
   */
  selectMonthlyAttendanceRate: `
    SELECT
      CASE WHEN t.total_count = 0 THEN 0
           ELSE p.present_count::float / t.total_count
      END AS rate
    FROM (
      SELECT COUNT(*)::int AS total_count
      FROM students
      WHERE school = $1
    ) AS t,
    (
      SELECT COUNT(DISTINCT ga.student_id)::int AS present_count
      FROM general_attendance ga
      JOIN students s ON ga.student_id = s.student_id
      WHERE ga.attendance_date BETWEEN date_trunc('month', $2::date) AND $2::date
        AND ga.status IN ('PRESENT','LATE')
        AND s.school = $1
    ) AS p
  `,

  /**
   * Report Cards Generated: count in a term for given school
   * Params: school (public.school enum), term (varchar)
   */
  selectReportCardsCount: `
    SELECT COUNT(*)::int AS count
    FROM report_cards rc
    JOIN students s ON rc.student_id = s.student_id
    WHERE rc.term = $2
      AND s.school = $1
  `,

  /**
   * Average Student Grade: average of per-class final grades across students for school
   * Params: school (public.school enum)
   */
  selectAverageStudentGrade: `
    SELECT ROUND(AVG(class_grade)::numeric, 2) AS average_grade
    FROM (
      SELECT
        sa.student_id,
        c.class_id,
        SUM(COALESCE(sa.score, 0) * (a.weight_percent / 100.0)) AS class_grade
      FROM student_assessments sa
      JOIN assessments a ON sa.assessment_id = a.assessment_id
      JOIN classes c ON a.class_id = c.class_id
      JOIN students s ON sa.student_id = s.student_id
      WHERE s.school = $1
      GROUP BY sa.student_id, c.class_id
    ) AS sub
  `
};

module.exports = dashboardQueries;
