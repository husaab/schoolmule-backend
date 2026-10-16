// services/classroom/workStatus.js
//
// The single work-status rule (spec 0.8): what one item is for one student.
// The student, the parent lens and the teacher's counts all use it; its SQL
// twin is WORK_STATE_SQL (queries/workState.js, re-exported by
// queries/classworkSubmission.queries.js), and an integration test holds the
// two to the same answer for every branch. "Missing" past the due date is
// derived here at read time (D7): nothing is written.

const GRADE_STATES = ['missing', 'excused'];

/**
 * A grade the student and parent may see: the assessment is published and the
 * student's cell holds a score, or a missing/excused status. A score on an
 * unpublished assessment (a draft) is never visible.
 * @param {{isPublished: boolean, row: {score, status}|null}|null} grade
 */
const isGradeVisible = (grade) => Boolean(
  grade?.isPublished && grade.row && (grade.row.score != null || GRADE_STATES.includes(grade.row.status)),
);

/**
 * Something is turned in online: a quiz, or an assignment that takes work.
 * An assignment with "Nothing to turn in" (submission mode none: done in
 * class, graded on paper) is never Assigned or Missing for a student.
 * @param {{kind, submissionMode?}} item
 */
const isTurnInItem = (item) => item.kind === 'quiz' || (item.kind === 'assignment' && item.submissionMode !== 'none');

const out = (status, isLate = false) => ({ status, isLate: Boolean(isLate), missingDerived: false });

/**
 * @param {{kind, submissionMode?, assessmentId, dueAt}} item
 * @param {{turnedInAt, isLate}|null} sub
 * @param {{isPublished: boolean, row: {score, status}|null}} grade   // student_assessments row of this student, if any
 * @returns {{ status: WorkStatus, isLate: boolean, missingDerived: boolean }}
 */
function workStatus(item, sub, grade, now = new Date()) {
  const visible = isGradeVisible(grade);
  if (visible && grade.row.status === 'excused') return out('excused');
  if (visible && grade.row.status === 'missing') return out('missing');
  if (visible) return out('graded', sub?.isLate);
  if (item.kind === 'material') return out('material');
  if (!isTurnInItem(item)) return out('no_turn_in');
  if (sub?.turnedInAt) return out('turned_in', sub.isLate);
  if (item.dueAt && new Date(item.dueAt) < now) return { status: 'missing', isLate: false, missingDerived: true };
  return out('assigned');
}

module.exports = { workStatus, isGradeVisible, isTurnInItem };
