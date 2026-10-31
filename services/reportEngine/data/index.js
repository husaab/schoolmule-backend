// services/reportEngine/data/index.js
//
// ONE assembler for everything a student's report can print: the ReportData
// object (contract: schoolmule/src/reportkit/types.ts, `ReportData`) for any
// grade (JK, SK, 1-8) and either document type. It reads exactly what the
// four legacy generators read — same queries, fallbacks and grade numbers —
// so a designed template prints the same values the old cards do:
//
//   grades 1-8 report card      controllers/reportCard.controller.js:584
//     Al Haadi Term 2 variant   controllers/reportCard.controller.js:760
//   grades 1-8 progress report  controllers/progressReports.controller.js:412
//   JK progress / report card   controllers/jk.controller.js:521 / :613
//   SK progress / report card   controllers/sk.controller.js:463 / :566
//
// The legacy controllers don't call this yet; __tests__/integration/services/
// reportEngineData.test.js pins the two side by side.

const db = require('../../../config/database');
const { ReportSkip } = require('./errors');
const {
  loadStudent,
  loadHomeroomTeacher,
  loadDaysAbsent,
  loadTeacherAssistant,
  loadSchool,
  loadAssets,
  resolveSchoolYearLabel,
} = require('./common');
const { buildReportCardSubjects, buildAlHaadiT2Subjects } = require('./subjects');
const { buildProgressSubjects } = require('./progress');
const { buildSkills } = require('./skills');
const { buildComments } = require('./comments');
const { buildLearningSkills } = require('./learningSkills');
const {
  termLabel,
  termNumber,
  gradeText,
  gradeLabel,
  gradeNumber,
  splitName,
  isAlHaadiT2,
  isoDateInTimeZone,
  generatedDateToday,
  isIsoDate,
  text,
} = require('./format');

const DATA_VERSION = 1;
const DOC_TYPES = ['report_card', 'progress_report'];
const KINDERGARTEN = new Set(['JK', 'SK']);

/** The subject rows for a grades 1-8 student (JK/SK print skills instead). */
function buildSubjects(client, student, docType, term) {
  if (docType === 'progress_report') {
    return buildProgressSubjects(client, student.student_id, student.school, term);
  }
  if (isAlHaadiT2(student.school, term)) {
    return buildAlHaadiT2Subjects(client, student.student_id, student.school, term);
  }
  return buildReportCardSubjects(client, student.student_id, term);
}

/**
 * Build one student's ReportData.
 *
 * @param {object}  args
 * @param {string}  args.studentId
 * @param {'report_card'|'progress_report'} args.docType
 * @param {string}  args.term        the term name, e.g. "Term 1"
 * @param {string|null} [args.reportDate]  YYYY-MM-DD; default today in the school's timezone
 * @param {{ query: Function }} [args.client]  a pg pool or client (default: the app pool)
 * @returns {Promise<object>} ReportData (dataVersion 1)
 * @throws {ReportSkip} bad arguments (400), no such student (404), and the
 *         grades 1-8 progress report's "term not found" / "no classes" (422)
 */
async function assembleReportData({ studentId, docType, term, reportDate = null, client = db } = {}) {
  if (!studentId) throw new ReportSkip('studentId is required', 400);
  if (!DOC_TYPES.includes(docType)) throw new ReportSkip(`Unknown document type "${docType}"`, 400);
  if (typeof term !== 'string' || !term.trim()) throw new ReportSkip('term is required', 400);
  if (reportDate != null && !isIsoDate(reportDate)) {
    throw new ReportSkip(`reportDate must be YYYY-MM-DD, got "${reportDate}"`, 400);
  }

  const student = await loadStudent(client, studentId);
  const grade = gradeText(student.grade);
  const isKindergarten = KINDERGARTEN.has(grade);

  const homeroomTeacher = await loadHomeroomTeacher(client, student.homeroom_teacher_id);
  // Subjects first: the grades 1-8 progress report's skips fire here, before
  // any other work, as they do in the legacy generator.
  const subjects = isKindergarten ? [] : await buildSubjects(client, student, docType, term);

  const teacherAssistant = await loadTeacherAssistant(client, student.student_id, grade, term);
  const daysAbsent = await loadDaysAbsent(client, student.student_id);
  const school = await loadSchool(client, student.school);
  const assets = await loadAssets(client, school);

  const date = reportDate || isoDateInTimeZone(school.timezone);
  const schoolYear = await resolveSchoolYearLabel(client, student.school, date);

  const skills = await buildSkills(client, student, docType, term);
  const comments = await buildComments(client, student, docType, term);
  const learningSkills = await buildLearningSkills(client, student, docType, term);

  const { firstName, lastName } = splitName(student.name);

  return {
    dataVersion: DATA_VERSION,
    meta: {
      docType,
      term,
      termNumber: termNumber(term),
      termLabel: termLabel(term),
      schoolYear,
      reportDate: date,
      generatedDate: generatedDateToday(),
    },
    school: school.info,
    assets,
    student: {
      id: student.student_id,
      name: text(student.name),
      firstName,
      lastName,
      oen: text(student.oen),
      grade,
      gradeLabel: gradeLabel(grade),
      gradeNumber: gradeNumber(grade),
      homeroomTeacher: text(homeroomTeacher),
      teacherAssistant,
      daysAbsent,
    },
    subjects,
    skills,
    comments,
    learningSkills,
    extra: {},
  };
}

module.exports = { assembleReportData, ReportSkip, DATA_VERSION, DOC_TYPES };
