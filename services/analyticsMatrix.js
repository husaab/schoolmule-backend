// services/analyticsMatrix.js
//
// Reads the analytics matrix narrow and joins it back into the rows the
// analytics engine groups: one per (class, student, assessment) with every
// column the old single wide query returned, in its order (class, student,
// then the assessment's sort order and date). A whole school is about a sixth
// of the bytes; one child's classes about a sixtieth.

const db = require('../config/database');
const q = require('../queries/analytics.queries');

const cellKey = (studentId, assessmentId) => `${studentId}:${assessmentId}`;

/**
 * Join the narrow reads into matrix rows. A cell with no student_assessments
 * row is blank: no score, status 'graded'. The reads run in parallel, so a
 * class, student or assessment that appears between them is skipped until
 * the next read.
 */
function joinMatrixRows({ classes, assessments, enrollments, students, scores, leftOutCells }) {
  const classById = new Map(classes.map((c) => [c.class_id, c]));
  const studentById = new Map(students.map((s) => [s.student_id, s]));
  const assessmentsByClass = new Map();
  for (const a of assessments) {
    if (!assessmentsByClass.has(a.class_id)) assessmentsByClass.set(a.class_id, []);
    assessmentsByClass.get(a.class_id).push(a);
  }
  const scoreByCell = new Map(scores.map((s) => [cellKey(s.student_id, s.assessment_id), s]));
  const leftOut = new Set(leftOutCells.map((x) => `${x.class_id}:${cellKey(x.student_id, x.assessment_id)}`));

  const rows = [];
  for (const e of enrollments) {
    const cls = classById.get(e.class_id);
    const stu = studentById.get(e.student_id);
    const classAssessments = assessmentsByClass.get(e.class_id);
    if (!cls || !stu || !classAssessments) continue;
    for (const a of classAssessments) {
      const cell = scoreByCell.get(cellKey(e.student_id, a.assessment_id));
      const status = cell?.status ?? 'graded';
      rows.push({
        class_id: cls.class_id,
        class_grade: cls.class_grade,
        subject: cls.subject,
        teacher_name: cls.teacher_name,
        show_class_average: cls.show_class_average,
        term_id: cls.term_id,
        student_id: e.student_id,
        student_name: stu.student_name,
        student_grade: stu.student_grade,
        homeroom_teacher_id: stu.homeroom_teacher_id,
        assessment_id: a.assessment_id,
        assessment_name: a.assessment_name,
        weight_percent: a.weight_percent,
        weight_points: a.weight_points,
        max_score: a.max_score,
        is_parent: a.is_parent,
        parent_assessment_id: a.parent_assessment_id,
        assessment_date: a.assessment_date,
        sort_order: a.sort_order,
        is_published: a.is_published,
        parent_comment: a.parent_comment,
        published_at: a.published_at,
        is_turn_in: a.is_turn_in,
        score: cell ? cell.score : null,
        status,
        is_excluded: status === 'excused',
        stats_left_out_class: e.stats_left_out_class,
        stats_left_out_assessment: leftOut.has(`${e.class_id}:${cellKey(e.student_id, a.assessment_id)}`),
      });
    }
  }
  return rows;
}

/**
 * The matrix rows for one class set (queries/analytics.queries MATRIX_SCOPES).
 * @param {'term'|'allTerms'|'class'|'students'} scope
 * @param {Array} params the scope's params
 * @returns {Promise<object[]>}
 */
async function loadMatrixRows(scope, params) {
  const read = (queries) => db.query(queries[scope], params).then((r) => r.rows);
  const [classes, assessments, enrollments, students, scores, leftOutCells] = await Promise.all([
    read(q.selectMatrixClasses),
    read(q.selectMatrixAssessments),
    read(q.selectMatrixEnrollments),
    read(q.selectMatrixStudents),
    read(q.selectMatrixScores),
    read(q.selectMatrixLeftOutCells),
  ]);
  return joinMatrixRows({ classes, assessments, enrollments, students, scores, leftOutCells });
}

module.exports = { loadMatrixRows, joinMatrixRows };
