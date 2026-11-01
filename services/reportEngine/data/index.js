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
//   JK progress / report card   controllers/jk.controller.js legacyGenerateSingleJK{ProgressReport,ReportCard}
//   SK progress / report card   controllers/sk.controller.js legacyGenerateSingleSK{ProgressReport,ReportCard}
//
// The JK/SK progress reports print a report date, the school year it falls
// in, the days absent in that year up to the date, and the homeroom teacher
// else the grade's Kindergarten class teacher: those come from the same
// services/kindergartenProgressReport.loadProgressReportContext the legacy
// generators call. Every other document keeps the all-time absence count,
// 'N/A' teacher and the active-year rule.
//
// __tests__/integration/services/reportEngineData.test.js pins the assembler
// and the legacy generators side by side.

const db = require('../../../config/database');
const { loadProgressReportContext } = require('../../kindergartenProgressReport');
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
  formatSchoolYearLabel,
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
  const kindergartenProgress = isKindergarten && docType === 'progress_report';

  // Subjects first: the grades 1-8 progress report's skips fire here, before
  // any other work, as they do in the legacy generator.
  const subjects = isKindergarten ? [] : await buildSubjects(client, student, docType, term);

  const teacherAssistant = await loadTeacherAssistant(client, student.student_id, grade, term);
  const school = await loadSchool(client, student.school);
  const assets = await loadAssets(client, school);

  let homeroomTeacher;
  let daysAbsent;
  let date;
  let schoolYear;
  if (kindergartenProgress) {
    const context = await loadProgressReportContext(student, { reportDate, timezone: school.timezone, client });
    homeroomTeacher = context.teacherName;
    daysAbsent = context.daysAbsent;
    date = context.reportDate;
    // No school year at all: the legacy report prints none.
    schoolYear = context.schoolYearLabel ? formatSchoolYearLabel(context.schoolYearLabel) : '';
  } else {
    homeroomTeacher = await loadHomeroomTeacher(client, student.homeroom_teacher_id);
    daysAbsent = await loadDaysAbsent(client, student.student_id);
    date = reportDate || isoDateInTimeZone(school.timezone);
    schoolYear = await resolveSchoolYearLabel(client, student.school, date);
  }

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
