// What a JK/SK progress report prints about when and who
// (services/kindergartenProgressReport.js).

// The school year a date falls in; else the latest one that had started by
// then (a summer date reports on the year just ended); else the latest.
const selectSchoolYearForDate = `
  SELECT school_year_id, label, start_date::text AS start_date, end_date::text AS end_date
  FROM school_years
  WHERE school = $1
  ORDER BY ($2::date BETWEEN start_date AND end_date) DESC,
           (start_date <= $2::date) DESC,
           start_date DESC
  LIMIT 1
`;

// $2 null: no lower bound (the school has no school year).
const countDaysAbsent = `
  SELECT COUNT(*)::int AS days
  FROM general_attendance
  WHERE student_id = $1
    AND status = 'ABSENT'
    AND ($2::date IS NULL OR attendance_date >= $2::date)
    AND attendance_date <= $3::date
`;

const selectHomeroomTeacherName = `SELECT username FROM users WHERE user_id = $1`;

// The teacher of the grade's Kindergarten class that year ("Junior
// Kindergarten", "Senior Kindergarten"), preferring one the student is
// enrolled in. $1 student, $2 grade, $3 school year (or null), $4 school.
const selectKindergartenClassTeacherName = `
  SELECT COALESCE(NULLIF(TRIM(u.username), ''), c.teacher_name) AS teacher_name
  FROM classes c
  LEFT JOIN users u ON u.user_id = c.teacher_id
  WHERE c.school::text = $4::text
    AND c.grade::text = $2::text
    AND c.archived_at IS NULL
    AND c.subject ILIKE '%kindergarten%'
    AND ($3::uuid IS NULL OR c.school_year_id = $3::uuid)
    AND COALESCE(NULLIF(TRIM(u.username), ''), c.teacher_name) IS NOT NULL
  ORDER BY EXISTS (
             SELECT 1 FROM class_students cs WHERE cs.class_id = c.class_id AND cs.student_id = $1
           ) DESC,
           c.created_at
  LIMIT 1
`;

module.exports = {
  selectSchoolYearForDate,
  countDaysAbsent,
  selectHomeroomTeacherName,
  selectKindergartenClassTeacherName,
};
