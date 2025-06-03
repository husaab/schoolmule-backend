// queries/teacher.queries.js

const teacherQueries = {
  /**
   * GET all teachers in a given school.
   * $1 = school (public.school enum)
   */
  selectTeachersBySchool: `
    SELECT
      user_id,
      first_name,
      last_name,
      email
    FROM users
    WHERE role = 'TEACHER'
      AND school = $1
    ORDER BY last_name, first_name
  `
};

module.exports = teacherQueries;
