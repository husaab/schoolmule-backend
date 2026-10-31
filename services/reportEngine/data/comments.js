// services/reportEngine/data/comments.js
//
// The JK/SK progress report's comment rows, exactly as the legacy progress
// templates print them (templates/kindergartenProgressComments.js, the one
// row list both read):
//   SK  the nine "Strengths/Next Steps for Improvement" rows
//       (sk_progress_report_comments by section_type)
//   JK  the Teacher's Comments: academic achievement, socio-emotional
//       development (jk_progress_report_comments)
// Every row is present, in print order, with its stored text trimmed ('' when
// none); a saved section_type the report doesn't print is left out, as on
// paper. [] for report cards and grades 1-8.

const jkQueries = require('../../../queries/jk.queries');
const skQueries = require('../../../queries/sk.queries');
const { JK_PROGRESS_COMMENT_ROWS, SK_PROGRESS_COMMENT_ROWS } = require('../../../templates/kindergartenProgressComments');
const { gradeText, text } = require('./format');

const KINDS = {
  JK: { sql: jkQueries.getProgressReportCommentsForStudent, rows: JK_PROGRESS_COMMENT_ROWS },
  SK: { sql: skQueries.getProgressReportCommentsForStudent, rows: SK_PROGRESS_COMMENT_ROWS },
};

async function buildComments(client, student, docType, term) {
  if (docType !== 'progress_report') return [];
  const kind = KINDS[gradeText(student.grade)];
  if (!kind) return [];

  const { rows } = await client.query(kind.sql, [student.student_id, term]);
  const stored = {};
  for (const row of rows) stored[row.section_type] = row.comment;
  return kind.rows.map((row) => ({
    key: row.key,
    label: row.label,
    caption: row.caption || '',
    text: text(stored[row.key]).trim(),
  }));
}

module.exports = { buildComments };
