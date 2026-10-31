// services/reportEngine/data/comments.js
//
// The JK/SK progress report's free comments (jk_progress_report_comments /
// sk_progress_report_comments, e.g. academic_achievement, socio_emotional)
// for the report's term, in the SQL's section_type order. The legacy
// progress templates don't print these yet; the designer's comments table
// does. [] for report cards and grades 1-8.

const jkQueries = require('../../../queries/jk.queries');
const skQueries = require('../../../queries/sk.queries');
const { gradeText, humanizeKey, text } = require('./format');

async function buildComments(client, student, docType, term) {
  if (docType !== 'progress_report') return [];
  const g = gradeText(student.grade);
  const sql = g === 'JK' ? jkQueries.getProgressReportCommentsForStudent
    : g === 'SK' ? skQueries.getProgressReportCommentsForStudent
      : null;
  if (!sql) return [];

  const { rows } = await client.query(sql, [student.student_id, term]);
  return rows.map((row) => ({
    key: text(row.section_type),
    label: humanizeKey(row.section_type),
    caption: '',
    text: text(row.comment),
  }));
}

module.exports = { buildComments };
