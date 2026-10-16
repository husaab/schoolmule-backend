// services/classroom/classroomSettings.js
//
// The school's classroom settings (who gets a student login, QR cards,
// student email, the parents' weekly summary day...). One row per school;
// a school that never saved them gets DEFAULTS with updatedAt null.

const db = require('../../config/database');
const q = require('../../queries/classroomSettings.queries');
const { GRADE_CODES } = require('../../utils/gradeRank');

const DEFAULTS = Object.freeze({
  enabled: false,
  loginFromGrade: '1',
  qrUntilGrade: '3',
  studentEmailFromGrade: '1',
  parentsReadPrivateComments: true,
  summaryDow: 5,
  studentPhotos: false,
  consentNoticeVersion: '2026-10',
});

const MAX_NOTICE_VERSION = 40;

const iso = (value) => (value ? new Date(value).toISOString() : null);

const toSettings = (row) => ({
  enabled: row.enabled,
  loginFromGrade: row.login_from_grade,
  qrUntilGrade: row.qr_until_grade,
  studentEmailFromGrade: row.student_email_from_grade ?? null,
  parentsReadPrivateComments: row.parents_read_private_comments,
  summaryDow: Number(row.summary_dow),
  studentPhotos: row.student_photos,
  consentNoticeVersion: row.consent_notice_version,
  updatedAt: iso(row.updated_at),
});

/** ClassroomSettings for a school: the saved row, or the defaults. */
async function getSettings(school) {
  const { rows } = await db.query(q.selectSettings, [school]);
  return rows[0] ? toSettings(rows[0]) : { ...DEFAULTS, updatedAt: null };
}

const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
const GRADE_LIST = GRADE_CODES.join(', ');

/**
 * Validate a full settings body (PUT). Every field is required;
 * studentEmailFromGrade may be null (student email off). updatedAt is ignored.
 * @returns {{ value: object } | { error: string }}
 */
function validateSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the classroom settings' };

  for (const key of Object.keys(DEFAULTS)) {
    if (!has(body, key)) return { error: `${key} is required` };
  }
  for (const key of ['enabled', 'parentsReadPrivateComments', 'studentPhotos']) {
    if (typeof body[key] !== 'boolean') return { error: `${key} must be true or false` };
  }
  for (const key of ['loginFromGrade', 'qrUntilGrade']) {
    if (!GRADE_CODES.includes(body[key])) return { error: `${key} must be one of ${GRADE_LIST}` };
  }
  if (body.studentEmailFromGrade !== null && !GRADE_CODES.includes(body.studentEmailFromGrade)) {
    return { error: `studentEmailFromGrade must be null or one of ${GRADE_LIST}` };
  }
  if (!Number.isInteger(body.summaryDow) || body.summaryDow < 0 || body.summaryDow > 6) {
    return { error: 'summaryDow must be a whole number from 0 (Sunday) to 6 (Saturday)' };
  }
  const version = typeof body.consentNoticeVersion === 'string' ? body.consentNoticeVersion.trim() : '';
  if (version.length < 1 || version.length > MAX_NOTICE_VERSION) {
    return { error: `consentNoticeVersion must be 1 to ${MAX_NOTICE_VERSION} characters` };
  }

  return {
    value: {
      enabled: body.enabled,
      loginFromGrade: body.loginFromGrade,
      qrUntilGrade: body.qrUntilGrade,
      studentEmailFromGrade: body.studentEmailFromGrade,
      parentsReadPrivateComments: body.parentsReadPrivateComments,
      summaryDow: body.summaryDow,
      studentPhotos: body.studentPhotos,
      consentNoticeVersion: version,
    },
  };
}

/** Upsert the school's settings and return them as ClassroomSettings. */
async function saveSettings(school, value, userId) {
  const { rows } = await db.query(q.upsertSettings, [
    school,
    value.enabled,
    value.loginFromGrade,
    value.qrUntilGrade,
    value.studentEmailFromGrade,
    value.parentsReadPrivateComments,
    value.summaryDow,
    value.studentPhotos,
    value.consentNoticeVersion,
    userId || null,
  ]);
  return toSettings(rows[0]);
}

module.exports = { DEFAULTS, MAX_NOTICE_VERSION, getSettings, validateSettings, saveSettings, toSettings };
