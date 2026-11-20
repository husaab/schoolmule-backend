// What a JK/SK progress report prints about when (services/
// kindergartenProgressReport.js); who is queries/kindergartenStaff.queries.js.

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

module.exports = {
  selectSchoolYearForDate,
  countDaysAbsent,
};
