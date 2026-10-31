/**
 * What the JK and SK progress reports print beyond ratings and comments:
 * the report date, the school year it falls in, the days absent that year,
 * and the teacher's name. Shared by controllers/jk.controller.js,
 * controllers/sk.controller.js and the report engine's ReportData
 * (services/reportEngine/data/index.js), so both print the same values.
 */

const db = require('../config/database');
const logger = require('../logger');
const queries = require('../queries/kindergartenProgressReport.queries');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TIMEZONE = 'America/Toronto';

/** True for a real calendar date written YYYY-MM-DD. */
function isValidReportDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Today (YYYY-MM-DD) where the school is. */
function todayIn(timezone) {
  const day = (timeZone) => new Date().toLocaleDateString('en-CA', { timeZone });
  try {
    return day(timezone || DEFAULT_TIMEZONE);
  } catch {
    return day(DEFAULT_TIMEZONE); // an unknown timezone name
  }
}

/**
 * The `reportDate` of a generate request: absent → null (the report uses
 * today), otherwise it must be a valid YYYY-MM-DD. Returns { reportDate } or
 * { error } for a 400.
 */
function parseReportDate(body) {
  const raw = body?.reportDate;
  if (raw === undefined || raw === null || raw === '') return { reportDate: null };
  if (!isValidReportDate(raw)) return { error: 'reportDate must be a date written YYYY-MM-DD' };
  return { reportDate: raw };
}

// Most JK/SK students have no homeroom teacher set. The report then names
// their grade's Kindergarten class teacher, never an Arabic/French/Quran
// teacher: a blank is better than the wrong name, and many students aren't
// enrolled in the Kindergarten class itself.
async function teacherNameFor(student, schoolYearId, client) {
  if (student.homeroom_teacher_id) {
    const { rows } = await client.query(queries.selectHomeroomTeacherName, [student.homeroom_teacher_id]);
    if (rows[0]?.username) return rows[0].username;
  }
  const { rows } = await client.query(queries.selectKindergartenClassTeacherName, [
    student.student_id,
    student.grade,
    schoolYearId,
    student.school,
  ]);
  return rows[0]?.teacher_name || '';
}

/**
 * Everything a JK/SK progress report prints about when and who.
 * @param {object} student  a row of studentQueries.selectStudentById
 * @param {object} opts
 * @param {string|null} opts.reportDate  YYYY-MM-DD, or null for today
 * @param {string|null} opts.timezone    the school's timezone
 * @param {{ query: Function }} [opts.client]  a pg pool or client (default:
 *        the app pool); the report engine passes its own
 * @returns {Promise<{reportDate: string, schoolYearLabel: string|null, daysAbsent: number, teacherName: string}>}
 */
async function loadProgressReportContext(student, { reportDate = null, timezone = null, client = db } = {}) {
  const date = reportDate || todayIn(timezone);

  const { rows: yearRows } = await client.query(queries.selectSchoolYearForDate, [student.school, date]);
  const year = yearRows[0] || null;

  // Absences in that school year up to the report date (all of them before
  // a school year exists).
  let daysAbsent = 0;
  try {
    const upTo = year && year.end_date < date ? year.end_date : date;
    const { rows } = await client.query(queries.countDaysAbsent, [student.student_id, year?.start_date || null, upTo]);
    daysAbsent = rows[0]?.days || 0;
  } catch (err) {
    logger.warn({ err, studentId: student.student_id }, 'Could not count days absent for a progress report');
  }

  const teacherName = await teacherNameFor(student, year?.school_year_id || null, client);

  return { reportDate: date, schoolYearLabel: year?.label || null, daysAbsent, teacherName };
}

module.exports = {
  isValidReportDate,
  parseReportDate,
  loadProgressReportContext,
};
