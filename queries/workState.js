// queries/workState.js
//
// The SQL twin of services/classroom/workStatus.js (spec 0.8), as fragments
// over the aliases `i` (classwork_items), `a` (its assessment, LEFT JOINed),
// `sub` (this student's classwork_submissions row, LEFT JOINed) and `sa` (this
// student's student_assessments row, LEFT JOINed). Kept apart from the query
// files so classwork.queries.js (ITEM_COUNTS) and
// classworkSubmission.queries.js can both use them without a require cycle;
// classworkSubmission.queries.js re-exports them.

// A grade the student and parent may see: published, and a score or a
// missing/excused status in the cell.
const GRADE_VISIBLE = `(COALESCE(a.is_published, FALSE) AND sa.student_id IS NOT NULL
  AND (sa.score IS NOT NULL OR sa.status IN ('missing', 'excused')))`;

// Something is turned in online: a quiz, or an assignment that takes work
// (not "Nothing to turn in").
const TURN_IN_ITEM = `(i.kind = 'quiz' OR (i.kind = 'assignment' AND i.submission_mode <> 'none'))`;

// The WorkStatus, in workStatus()'s order. The derived "missing" compares
// with NOW(), which is constant inside a transaction.
const WORK_STATE_SQL = `(CASE
  WHEN ${GRADE_VISIBLE} AND sa.status = 'excused' THEN 'excused'
  WHEN ${GRADE_VISIBLE} AND sa.status = 'missing' THEN 'missing'
  WHEN ${GRADE_VISIBLE} THEN 'graded'
  WHEN i.kind = 'material' THEN 'material'
  WHEN NOT ${TURN_IN_ITEM} THEN 'no_turn_in'
  WHEN sub.turned_in_at IS NOT NULL THEN 'turned_in'
  WHEN i.due_at IS NOT NULL AND i.due_at < NOW() THEN 'missing'
  ELSE 'assigned' END)`;

// The late flag: only graded and turned-in work carries it.
const WORK_LATE_SQL = `(CASE WHEN ${WORK_STATE_SQL} IN ('graded', 'turned_in') THEN COALESCE(sub.is_late, FALSE) ELSE FALSE END)`;

// The joins that give one student's `sub` and `sa` for item `i`. `student`
// is a SQL expression for the student id (an alias column or a parameter).
const WORK_JOINS = (student) => `
LEFT JOIN classwork_submissions sub ON sub.item_id = i.item_id AND sub.student_id = ${student}
LEFT JOIN student_assessments sa ON sa.assessment_id = i.assessment_id AND sa.student_id = ${student}`;

module.exports = { GRADE_VISIBLE, TURN_IN_ITEM, WORK_STATE_SQL, WORK_LATE_SQL, WORK_JOINS };
