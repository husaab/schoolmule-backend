// services/classroom/studentRequestRules.js
//
// The pure rules of a student's account request: what a submission must look
// like, the honeypot, the row → API shape, and an invite the approval could
// not send as a refusal the admin can act on. No database.

const { GRADE_CODES } = require('../../utils/gradeRank');
const { EMAIL_RE } = require('./emailProblems');

const NAME_MAX = 60;
const EMAIL_MAX = 254;
// A full queue stops taking more (the form says try later), so a flood of
// junk can't grow the table without bound.
const MAX_PENDING_PER_SCHOOL = 300;

/** A refusal with an HTTP status, a machine-readable code and optional data. */
class StudentRequestError extends Error {
  constructor(status, message, code = null, data = null) {
    super(message);
    this.name = 'StudentRequestError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const text = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

/** True when the hidden `website` field (people never see it) was filled in. */
const isHoneypot = (body) => typeof body?.website === 'string' && body.website.trim() !== '';

/**
 * A request body as clean values, or the first thing wrong with it.
 * @returns {{ value: { school: string, firstName: string, lastName: string, grade: string, email: string } } | { error: string }}
 */
function cleanSubmission(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Fill in the form.' };
  const school = text(body.school);
  const firstName = text(body.firstName);
  const lastName = text(body.lastName);
  const grade = text(body.grade).toUpperCase();
  const email = text(body.email).toLowerCase();
  if (!school) return { error: 'Choose your school.' };
  if (!firstName || !lastName) return { error: 'Enter your first and last name.' };
  if (firstName.length > NAME_MAX || lastName.length > NAME_MAX) return { error: `Names can be up to ${NAME_MAX} characters.` };
  if (!GRADE_CODES.includes(grade)) return { error: 'Choose your grade.' };
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return { error: 'Enter your school email address.' };
  return { value: { school, firstName, lastName, grade, email } };
}

const iso = (v) => (v ? new Date(v).toISOString() : null);

/** A student_account_requests row as the admin API shows it. */
const toRequest = (row) => ({
  requestId: row.request_id,
  firstName: row.first_name,
  lastName: row.last_name,
  name: `${row.first_name} ${row.last_name}`,
  grade: row.grade,
  email: row.email,
  status: row.status,
  createdAt: iso(row.created_at),
  decidedAt: iso(row.decided_at),
  addressTaken: Boolean(row.address_taken),
});

// inviteStudent's skip reasons, as the approval's refusals.
const SKIP_CODES = Object.freeze({
  already_has_account: [409, 'ALREADY_HAS_LOGIN'],
  below_login_grade: [409, 'BELOW_LOGIN_GRADE'],
  email_in_use: [409, 'EMAIL_IN_USE'],
  family_address: [409, 'FAMILY_ADDRESS'],
  shared_with_student: [409, 'SHARED_WITH_STUDENT'],
  no_email: [400, 'INVALID_EMAIL'],
  invalid_email: [400, 'INVALID_EMAIL'],
});

/** A skipped inviteStudent result as a StudentRequestError, its message kept. */
function refusalFor(result) {
  const [status, code] = SKIP_CODES[result.reason] || [409, 'NOT_INVITED'];
  return new StudentRequestError(status, result.message, code);
}

module.exports = {
  NAME_MAX, EMAIL_MAX, MAX_PENDING_PER_SCHOOL, StudentRequestError, isHoneypot, cleanSubmission, toRequest, refusalFor,
};
