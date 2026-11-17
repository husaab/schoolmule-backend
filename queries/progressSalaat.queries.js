// Salaat on the grades 1-8 progress report: one row per student per term in
// progress_report_salaat, for schools with schools.progress_salaat on.

const { PERSON_NAME } = require('./personName');

const GRADES_1_TO_8 = `('1','2','3','4','5','6','7','8')`;

module.exports = {
  // $1 school
  selectSchoolSalaat: `
    SELECT progress_salaat FROM schools WHERE school_code::text = $1
  `,

  // The grades 1-8 students of a school year with their Salaat entry for the
  // term, optionally only one homeroom teacher's. Archived students are left
  // out. $1 school, $2 school_year_id, $3 term, $4 homeroom teacher (null = all)
  selectRoster: `
    SELECT s.student_id, s.name, s.grade::text AS grade, s.homeroom_teacher_id,
           CASE WHEN h.user_id IS NULL THEN NULL ELSE ${PERSON_NAME('h')} END AS homeroom_teacher,
           ps.work_habit, ps.behavior, ps.comment, ps.updated_at
      FROM students s
      LEFT JOIN users h ON h.user_id = s.homeroom_teacher_id
      LEFT JOIN progress_report_salaat ps ON ps.student_id = s.student_id AND ps.term = $3
     WHERE s.school::text = $1
       AND s.school_year_id IS NOT DISTINCT FROM $2
       AND s.is_archived = false
       AND s.grade::text IN ${GRADES_1_TO_8}
       AND ($4::uuid IS NULL OR s.homeroom_teacher_id = $4)
     ORDER BY s.grade::text, s.name
  `,

  // $1 student
  selectStudent: `
    SELECT student_id, school::text AS school, grade::text AS grade, homeroom_teacher_id
      FROM students
     WHERE student_id = $1
  `,

  // $1 student, $2 term
  selectEntry: `
    SELECT work_habit, behavior, comment, updated_at
      FROM progress_report_salaat
     WHERE student_id = $1 AND term = $2
  `,

  // $1 student, $2 term, $3 work habit, $4 behaviour, $5 comment, $6 user
  upsertEntry: `
    INSERT INTO progress_report_salaat (student_id, term, work_habit, behavior, comment, updated_by, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (student_id, term) DO UPDATE SET
      work_habit = EXCLUDED.work_habit,
      behavior   = EXCLUDED.behavior,
      comment    = EXCLUDED.comment,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING work_habit, behavior, comment, updated_at
  `,

  // $1 student, $2 term
  deleteEntry: `
    DELETE FROM progress_report_salaat WHERE student_id = $1 AND term = $2
  `,

  GRADES: ['1', '2', '3', '4', '5', '6', '7', '8'],
};
