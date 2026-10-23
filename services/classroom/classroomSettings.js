// services/classroom/classroomSettings.js
//
// The school's classroom settings (who gets a student login, QR cards,
// student email, the parents' weekly summary and its day...). One row per
// school; a school that never saved them gets DEFAULTS with updatedAt null.
// `enabled` is the student portal (student sign-in and student email);
// `parentSummary` is the parents' weekly summary, its own switch;
// `replyReminders` and `parentNudge` chase unanswered conversations
// (services/replyReminders.js).

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
  parentSummary: false,
  replyReminders: false,
  parentNudge: false,
  studentPhotos: false,
  consentNoticeVersion: '2026-10',
  // The domains of the school's student addresses ([] = no domain checks).
  studentEmailDomains: [],
  // 'google_only' turns password sign-in off for students.
  studentSignIn: 'google_or_password',
});

// Keys every PUT must carry. The settings that came later (the two
// invitation ones, parentSummary, replyReminders, parentNudge) are optional, as is consentNoticeVersion
// now that it is not shown, so an older body keeps working (they then keep
// their saved values).
const REQUIRED_KEYS = [
  'enabled', 'loginFromGrade', 'qrUntilGrade', 'studentEmailFromGrade',
  'parentsReadPrivateComments', 'summaryDow', 'studentPhotos',
];

const MAX_NOTICE_VERSION = 40;
const MAX_EMAIL_DOMAINS = 5;
const STUDENT_SIGN_IN = ['google_or_password', 'google_only'];
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/;
const DOMAINS_ERROR = 'studentEmailDomains must be domain names like students.example.org';

const iso = (value) => (value ? new Date(value).toISOString() : null);

const toSettings = (row) => ({
  enabled: row.enabled,
  loginFromGrade: row.login_from_grade,
  qrUntilGrade: row.qr_until_grade,
  studentEmailFromGrade: row.student_email_from_grade ?? null,
  parentsReadPrivateComments: row.parents_read_private_comments,
  summaryDow: Number(row.summary_dow),
  parentSummary: row.parent_summary === true,
  replyReminders: row.reply_reminders === true,
  parentNudge: row.parent_nudge === true,
  studentPhotos: row.student_photos,
  consentNoticeVersion: row.consent_notice_version,
  studentEmailDomains: row.student_email_domains ?? [],
  studentSignIn: row.student_sign_in ?? DEFAULTS.studentSignIn,
  updatedAt: iso(row.updated_at),
});

/** ClassroomSettings for a school: the saved row, or the defaults. */
async function getSettings(school) {
  const { rows } = await db.query(q.selectSettings, [school]);
  return rows[0] ? toSettings(rows[0]) : { ...DEFAULTS, studentEmailDomains: [], updatedAt: null };
}

const has = (body, key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
const GRADE_LIST = GRADE_CODES.join(', ');

/** Trimmed, lowercased, de-duplicated domains, or { error }. */
function parseDomains(raw) {
  if (!Array.isArray(raw)) return { error: DOMAINS_ERROR };
  const domains = [...new Set(raw.map((d) => (typeof d === 'string' ? d.trim().toLowerCase() : '')))];
  if (!domains.every((d) => DOMAIN_RE.test(d))) return { error: DOMAINS_ERROR };
  if (domains.length > MAX_EMAIL_DOMAINS) return { error: `studentEmailDomains can list up to ${MAX_EMAIL_DOMAINS} domains` };
  return { domains };
}

/**
 * Validate a settings body (PUT). Every REQUIRED_KEYS field must be there;
 * studentEmailFromGrade may be null (student email off). studentEmailDomains
 * and studentSignIn are optional and fall back to `current` (the saved
 * settings). updatedAt is ignored.
 * @returns {{ value: object } | { error: string }}
 */
function validateSettings(body, current = DEFAULTS) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the classroom settings' };

  for (const key of REQUIRED_KEYS) {
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
  const switches = {};
  for (const key of ['parentSummary', 'replyReminders', 'parentNudge']) {
    switches[key] = has(body, key) ? body[key] : (current[key] ?? DEFAULTS[key]);
    if (typeof switches[key] !== 'boolean') return { error: `${key} must be true or false` };
  }
  const version = has(body, 'consentNoticeVersion')
    ? (typeof body.consentNoticeVersion === 'string' ? body.consentNoticeVersion.trim() : '')
    : (current.consentNoticeVersion ?? DEFAULTS.consentNoticeVersion);
  if (version.length < 1 || version.length > MAX_NOTICE_VERSION) {
    return { error: `consentNoticeVersion must be 1 to ${MAX_NOTICE_VERSION} characters` };
  }
  let studentEmailDomains = current.studentEmailDomains ?? DEFAULTS.studentEmailDomains;
  if (has(body, 'studentEmailDomains')) {
    const parsed = parseDomains(body.studentEmailDomains);
    if (parsed.error) return { error: parsed.error };
    studentEmailDomains = parsed.domains;
  }
  const studentSignIn = has(body, 'studentSignIn') ? body.studentSignIn : (current.studentSignIn ?? DEFAULTS.studentSignIn);
  if (!STUDENT_SIGN_IN.includes(studentSignIn)) {
    return { error: "studentSignIn must be 'google_or_password' or 'google_only'" };
  }

  return {
    value: {
      enabled: body.enabled,
      loginFromGrade: body.loginFromGrade,
      qrUntilGrade: body.qrUntilGrade,
      studentEmailFromGrade: body.studentEmailFromGrade,
      parentsReadPrivateComments: body.parentsReadPrivateComments,
      summaryDow: body.summaryDow,
      ...switches,
      studentPhotos: body.studentPhotos,
      consentNoticeVersion: version,
      studentEmailDomains,
      studentSignIn,
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
    value.studentEmailDomains,
    value.studentSignIn,
    value.parentSummary,
    value.replyReminders,
    value.parentNudge,
  ]);
  return toSettings(rows[0]);
}

module.exports = { DEFAULTS, MAX_NOTICE_VERSION, getSettings, validateSettings, saveSettings, toSettings };
