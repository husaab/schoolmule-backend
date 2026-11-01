// services/reportEngine/data/common.js
//
// The parts every report shares: the student, homeroom teacher, teacher
// assistant, absences, the school, its signed images and the school year.
// Each loader mirrors the legacy generators' query and fallback. (The JK/SK
// progress reports read their teacher, absences and year through
// services/kindergartenProgressReport instead: see index.js.)

const supabase = require('../../../config/supabaseClient');
const logger = require('../../../logger');
const studentQueries = require('../../../queries/student.queries');
const schoolAssetsQueries = require('../../../queries/schoolAssets.queries');
const jkQueries = require('../../../queries/jk.queries');
const skQueries = require('../../../queries/sk.queries');
const q = require('../../../queries/reportEngineData.queries');
const { schoolWebsite } = require('../../../templates/printKit');
const { ReportSkip } = require('./errors');
const {
  DEFAULT_TIMEZONE,
  academicYearFor,
  formatSchoolYearLabel,
  gradeText,
  normalizeSchoolCode,
  text,
} = require('./format');

const SIGNED_URL_SECONDS = 3600; // the legacy 1-hour links
const ASSETS_BUCKET = 'school-assets';

async function loadStudent(client, studentId) {
  const { rows } = await client.query(studentQueries.selectStudentById, [studentId]);
  // Every legacy path stops here; the message is the one callers match on.
  if (rows.length === 0) throw new ReportSkip('Student not found', 404);
  return rows[0];
}

/** users.username of the homeroom teacher, else 'N/A' (the legacy text). */
async function loadHomeroomTeacher(client, homeroomTeacherId) {
  const { rows } = await client.query(q.selectHomeroomTeacherName, [homeroomTeacherId]);
  return rows.length > 0 ? rows[0].username : 'N/A';
}

/** Days marked ABSENT in general attendance; 0 if the count fails (legacy). */
async function loadDaysAbsent(client, studentId) {
  try {
    const { rows } = await client.query(q.countDaysAbsent, [studentId]);
    return parseInt(rows[0]?.days_absent || 0, 10);
  } catch (err) {
    return 0;
  }
}

/** The JK/SK teacher assistant saved for the term; '' for other grades. */
async function loadTeacherAssistant(client, studentId, grade, term) {
  const g = gradeText(grade);
  const sql = g === 'JK' ? jkQueries.getTeacherAssistant
    : g === 'SK' ? skQueries.getTeacherAssistant
      : null;
  if (!sql) return '';
  const { rows } = await client.query(sql, [studentId, term]);
  return rows.length > 0 ? text(rows[0].teacher_assistant_name) : '';
}

/**
 * The schools row for the student's school. A missing row (or table) falls
 * back to the school code as its name, like every legacy generator.
 * @returns {{ code, schoolId, timezone, info: ReportData['school'] }}
 */
async function loadSchool(client, schoolCode) {
  const info = {
    code: text(schoolCode),
    name: text(schoolCode),
    address: '',
    phone: '',
    email: '',
    // From the contact email's domain, as the JK/SK progress footers print
    // it (printKit.schoolWebsite); '' for a free-mail address.
    website: '',
    // School Settings → School Information (schools.principal_name / board_name).
    principal: '',
    board: '',
  };
  let schoolId = null;
  let timezone = DEFAULT_TIMEZONE;
  try {
    const { rows } = await client.query(q.selectSchoolByCode, [normalizeSchoolCode(schoolCode)]);
    if (rows.length > 0) {
      const row = rows[0];
      schoolId = row.school_id || null;
      timezone = row.timezone || DEFAULT_TIMEZONE;
      info.name = text(row.name);
      info.address = text(row.address);
      info.phone = text(row.phone);
      info.email = text(row.email);
      info.website = text(schoolWebsite(row.email));
      info.principal = text(row.principal_name);
      info.board = text(row.board_name);
    }
  } catch (err) {
    logger.warn({ err }, 'reportEngine: could not read the schools row, using the school code');
  }
  return { code: info.code, schoolId, timezone, info };
}

async function signAsset(path) {
  if (!path) return null;
  const { data } = await supabase.storage.from(ASSETS_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  return data?.signedUrl || null;
}

/**
 * Logo, principal's signature and stamp as 1-hour signed URLs (null when
 * missing). Read by school_id when the school row exists (JK/SK/progress
 * paths), else by school code (the grades 1-8 report card path) — one
 * school_assets row either way, since school_id is its key.
 */
async function loadAssets(client, school) {
  const assets = { logo: null, principalSignature: null, stamp: null, teacherSignature: null };
  try {
    const { rows } = school.schoolId
      ? await client.query(schoolAssetsQueries.getSchoolAssetsBySchoolId, [school.schoolId])
      : await client.query(schoolAssetsQueries.getSchoolAssetsBySchoolCode, [normalizeSchoolCode(school.code)]);
    if (rows.length > 0) {
      const row = rows[0];
      assets.logo = await signAsset(row.logo_path);
      assets.principalSignature = await signAsset(row.principal_signature_path);
      assets.stamp = await signAsset(row.school_stamp_path);
    }
  } catch (err) {
    logger.warn({ err }, 'reportEngine: could not load school assets');
  }
  return assets;
}

/**
 * "2026 - 2027": the school year the report date falls in (else the active
 * one, else the latest); with no school_years row at all, the legacy
 * September-rollover rule applied to the report date.
 */
async function resolveSchoolYearLabel(client, schoolCode, reportDate) {
  try {
    const { rows } = await client.query(q.selectSchoolYearForDate, [schoolCode, reportDate]);
    if (rows.length > 0 && rows[0].label) return formatSchoolYearLabel(rows[0].label);
  } catch (err) {
    logger.warn({ err }, 'reportEngine: could not read school_years, using the September rule');
  }
  return academicYearFor(reportDate);
}

module.exports = {
  loadStudent,
  loadHomeroomTeacher,
  loadDaysAbsent,
  loadTeacherAssistant,
  loadSchool,
  loadAssets,
  resolveSchoolYearLabel,
};
