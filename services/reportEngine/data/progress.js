// services/reportEngine/data/progress.js
//
// Progress-report subject rows for grades 1-8: one row per class the student
// takes in the term, with that class's progress_report_feedback. Mirrors
// generateSingleProgressReport (controllers/progressReports.controller.js:412),
// including its two skips.

const termQueries = require('../../../queries/term.queries');
const progressReportsQueries = require('../../../queries/progressReports.queries');
const q = require('../../../queries/reportEngineData.queries');
const { ReportSkip } = require('./errors');
const { text } = require('./format');

/**
 * SubjectRow[] for a grades 1-8 progress report.
 * @throws {ReportSkip} the term doesn't exist for the school, or the student
 *         has no classes in it (same messages and 422 status as legacy)
 */
async function buildProgressSubjects(client, studentId, school, term) {
  const { rows: termRows } = await client.query(termQueries.selectTermByNameAndSchool, [term, school]);
  if (termRows.length === 0) throw new ReportSkip(`Term "${term}" not found for school`);
  const termId = termRows[0].term_id;

  const { rows: classRows } = await client.query(q.selectStudentClassesForProgressTerm, [studentId, termId]);
  if (classRows.length === 0) throw new ReportSkip(`Student not enrolled in any classes for ${term}`);

  const subjects = [];
  for (const cls of classRows) {
    const { rows } = await client.query(progressReportsQueries.getProgressReportFeedback, [studentId, cls.class_id, term]);
    const fb = rows[0] || null;
    subjects.push({
      id: cls.class_id,
      name: text(cls.subject),
      teacher: text(cls.teacher_name),
      mark: null,
      workHabits: text(fb?.work_habit),
      behaviour: text(fb?.behavior),
      coreStandards: text(fb?.core_standards),
      comment: text(fb?.comment),
      terms: {},
    });
  }
  return subjects;
}

module.exports = { buildProgressSubjects };
