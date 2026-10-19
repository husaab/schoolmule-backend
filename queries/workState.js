// queries/workState.js
//
// The SQL twin of services/classroom/workStatus.js (spec 0.8), as fragments
// over the aliases `i` (classwork_items), `a` (its assessment, LEFT JOINed),
// `sub` (this student's classwork_submissions row, LEFT JOINed), `sa` (this
// student's student_assessments row, LEFT JOINed) and `wst` (the student's
// students row). WORK_JOINS(student) adds `sub`, `sa` and `wst`; every query
// that uses WORK_STATE_SQL joins through it. Kept apart from the query files
// so classwork.queries.js (ITEM_COUNTS) and classworkSubmission.queries.js
// can both use them without a require cycle; classworkSubmission.queries.js
// re-exports them.

const { SIGNS_IN } = require('./studentSignsIn');

// A grade the student and parent may see: published, and a score or a
// missing/excused status in the cell.
const GRADE_VISIBLE = `(COALESCE(a.is_published, FALSE) AND sa.student_id IS NOT NULL
  AND (sa.score IS NOT NULL OR sa.status IN ('missing', 'excused')))`;

// Something is turned in online: a quiz, or an assignment that takes work
// (not "Nothing to turn in").
const TURN_IN_ITEM = `(i.kind = 'quiz' OR (i.kind = 'assignment' AND i.submission_mode <> 'none'))`;

// The WorkStatus, in workStatus()'s order. The derived "missing" compares
// with NOW(), which is constant inside a transaction, and only applies to a
// student who can sign in (SIGNS_IN): a child with no way to turn work in
// online is never "missing" by a due date alone (work done in class stays
// Assigned until the teacher grades it, marks it missing or excuses it).
// A teacher-confirmed, published Missing (the branches above) still shows.
// WORK_STATE_AT(now) is the same rule as of `now` (a SQL timestamptz
// expression), for the classroom emails' scheduler (T21); WORK_STATE_SQL is
// it at NOW().
const WORK_STATE_AT = (now) => `(CASE
  WHEN ${GRADE_VISIBLE} AND sa.status = 'excused' THEN 'excused'
  WHEN ${GRADE_VISIBLE} AND sa.status = 'missing' THEN 'missing'
  WHEN ${GRADE_VISIBLE} THEN 'graded'
  WHEN i.kind = 'material' THEN 'material'
  WHEN NOT ${TURN_IN_ITEM} THEN 'no_turn_in'
  WHEN sub.turned_in_at IS NOT NULL THEN 'turned_in'
  WHEN i.due_at IS NOT NULL AND i.due_at < ${now} AND ${SIGNS_IN('wst')} THEN 'missing'
  ELSE 'assigned' END)`;
const WORK_STATE_SQL = WORK_STATE_AT('NOW()');

// The late flag: only graded and turned-in work carries it.
const WORK_LATE_SQL = `(CASE WHEN ${WORK_STATE_SQL} IN ('graded', 'turned_in') THEN COALESCE(sub.is_late, FALSE) ELSE FALSE END)`;

// A draft on the submission: a score or status saved for a gradebook column.
const HAS_DRAFT = `(sub.draft_score IS NOT NULL OR sub.draft_status IS NOT NULL)`;

// The teacher's unpublished draft (or feedback) was made before the student
// took the work back or turned it in again (Fable I1): it is held, the work
// is to grade again, and no Publish takes it until the teacher saves the
// score, status or feedback again (which clears the flag).
const DRAFT_PREDATES_WORK = `COALESCE(sub.draft_predates_work, FALSE)`;

// Turned in and waiting for the teacher: no draft and no visible grade; on an
// item with no gradebook column, no published feedback either (T16). Work
// turned in again after a draft waits too (DRAFT_PREDATES_WORK).
const AWAITING_GRADE = `(sub.turned_in_at IS NOT NULL AND (${DRAFT_PREDATES_WORK} OR (NOT ${HAS_DRAFT} AND NOT ${GRADE_VISIBLE}
  AND (i.assessment_id IS NOT NULL OR sub.published_at IS NULL))))`;

// A quiz attempt of this student with every answer given points (auto or
// the teacher's): nothing is left to grade by hand (T23).
const QUIZ_GRADED = `NOT EXISTS (SELECT 1 FROM quiz_attempts gqt JOIN quiz_answers gqa ON gqa.attempt_id = gqt.attempt_id
   WHERE gqt.item_id = i.item_id AND gqt.student_id = sub.student_id AND gqa.auto_points IS NULL AND gqa.teacher_points IS NULL)`;

// On an item with no gradebook column, what a Publish releases: the
// teacher's feedback, and for a quiz its results (T23), so a turned-in quiz
// is something to publish even with no feedback, once its written answers
// are graded.
const UNLINKED_PUBLISHABLE = `(sub.feedback IS NOT NULL OR (i.kind = 'quiz' AND sub.turned_in_at IS NOT NULL AND ${QUIZ_GRADED}))`;

// What "Publish to N students" counts (T16): on a gradebook column, a draft
// not published yet, or any draft while the column itself is unpublished; on
// an item with no column, feedback (or a quiz's results) not published yet.
// Never a held draft (DRAFT_PREDATES_WORK).
const NEEDS_PUBLISH = `(NOT ${DRAFT_PREDATES_WORK} AND CASE WHEN i.assessment_id IS NOT NULL
    THEN ${HAS_DRAFT} AND (sub.published_at IS NULL OR NOT COALESCE(a.is_published, FALSE))
    ELSE ${UNLINKED_PUBLISHABLE} AND sub.published_at IS NULL END)`;

// The joins that give one student's `sub`, `sa` and `wst` (their students
// row, for SIGNS_IN) for item `i`. `student` is a SQL expression for the
// student id (an alias column or a parameter).
const WORK_JOINS = (student) => `
LEFT JOIN classwork_submissions sub ON sub.item_id = i.item_id AND sub.student_id = ${student}
LEFT JOIN student_assessments sa ON sa.assessment_id = i.assessment_id AND sa.student_id = ${student}
LEFT JOIN students wst ON wst.student_id = ${student}`;

module.exports = {
  GRADE_VISIBLE, TURN_IN_ITEM, WORK_STATE_AT, WORK_STATE_SQL, WORK_LATE_SQL, WORK_JOINS, HAS_DRAFT, AWAITING_GRADE, NEEDS_PUBLISH,
  UNLINKED_PUBLISHABLE, QUIZ_GRADED, DRAFT_PREDATES_WORK,
};
