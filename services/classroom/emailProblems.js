// services/classroom/emailProblems.js
//
// What is wrong with a student's own address, judged one way everywhere: the
// Student accounts list, Edit email, the email import and the invite. An
// address is never used to find a student; these checks only say whether an
// address the admin chose for a student row can safely be theirs.
//
// Blocking problems (the address can't be saved or invited):
//   email_in_use         another SchoolMule account signs in with it
//   family_address       a parent's address on file for this student
//   shared_with_student  another student of the same school year has it
//   invalid_email, has_login (import only), duplicate_in_list (import only)
// Warnings (the admin decides):
//   outside_domain, name_mismatch, replaces_existing

const db = require('../../config/database');
const { normalizeName } = require('../import/matching');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLE_WORD = { ADMIN: 'an admin', TEACHER: 'a teacher', PARENT: 'a parent', STUDENT: 'a student' };
const gradeLabel = (g) => (g === 'JK' || g === 'SK' ? g : `Grade ${g}`);

/** True when the school declares student domains and the address is on none of them. */
function isOutsideDomain(email, domains) {
  if (!Array.isArray(domains) || domains.length === 0) return false;
  const domain = String(email).slice(String(email).lastIndexOf('@') + 1).toLowerCase();
  return !domains.includes(domain);
}

// The name parts long enough to look for in an address (very short ones would
// match anything).
const nameParts = (name) => normalizeName(name).split(' ').filter((t) => t.length >= 3);

/**
 * True when the address's local part contains a name part of the student's
 * (3+ letters, accents and punctuation ignored), or when the name has no part
 * long enough to compare.
 */
function mentionsName(email, name) {
  const parts = nameParts(name);
  if (parts.length === 0) return true;
  const local = normalizeName(String(email).split('@')[0]).replace(/\s+/g, '');
  return parts.some((p) => local.includes(p));
}

/** The words for a blocking conflict found by conflictLateral. */
function conflictMessage(kind, { role, sameSchool, otherName, otherGrade } = {}) {
  if (kind === 'family_address') return "This is a parent's address on file. Use the student's own school address.";
  if (kind === 'shared_with_student') {
    return `Same address as ${otherName} (${gradeLabel(otherGrade)}). Each student needs their own.`;
  }
  return sameSchool
    ? `Already used by ${ROLE_WORD[role] || 'another'} account in this school. Each student needs their own address.`
    : 'Already used by another SchoolMule account.';
}

/**
 * The SQL that finds the first blocking conflict for an address chosen for a
 * student row, as `LEFT JOIN LATERAL (...) cf ON TRUE` with cf.kind, cf.role,
 * cf.same_school, cf.other_name and cf.other_grade (all NULL when clean).
 * `s` is the students alias, `email` the address expression and `ownUser`
 * the student's own login id expression (excluded from email_in_use).
 */
const conflictLateral = (s, email, ownUser) => `
LEFT JOIN LATERAL (
  SELECT c.kind, c.role, c.same_school, c.other_name, c.other_grade FROM (
    SELECT 1 AS pri, 'email_in_use' AS kind, x.role::text AS role, (x.school = ${s}.school) AS same_school,
           NULL::text AS other_name, NULL::text AS other_grade
      FROM users x
     WHERE ${email} IS NOT NULL AND LOWER(x.email) = LOWER(${email}) AND x.user_id IS DISTINCT FROM ${ownUser}
    UNION ALL
    SELECT 2, 'family_address', NULL, NULL, NULL, NULL
     WHERE ${email} IS NOT NULL
       AND LOWER(${email}) IN (LOWER(TRIM(COALESCE(${s}.mother_email, ''))), LOWER(TRIM(COALESCE(${s}.father_email, ''))))
    UNION ALL
    SELECT 2, 'family_address', NULL, NULL, NULL, NULL
      FROM parent_students ps LEFT JOIN users pu ON pu.user_id = ps.parent_id
     WHERE ps.student_id = ${s}.student_id AND ${email} IS NOT NULL
       AND LOWER(${email}) = LOWER(TRIM(COALESCE(pu.email, ps.parent_email, '')))
    UNION ALL
    SELECT 3, 'shared_with_student', NULL, NULL, o.name, o.grade::text
      FROM students o
     WHERE ${email} IS NOT NULL AND o.school = ${s}.school AND o.school_year_id = ${s}.school_year_id
       AND o.student_id <> ${s}.student_id AND o.is_archived IS NOT TRUE
       AND LOWER(TRIM(o.student_email)) = LOWER(TRIM(${email}))
  ) c ORDER BY c.pri, c.other_name LIMIT 1) cf ON TRUE`;

const problem = (code, blocking, message, extra = {}) => ({ code, blocking, message, ...extra });

/** The non-blocking problems with an address on a student row. */
function addressWarnings(email, name, domains) {
  const warnings = [];
  if (isOutsideDomain(email, domains)) {
    warnings.push(problem('outside_domain', false, `Not a school address (${domains.join(', ')})`));
  }
  if (!mentionsName(email, name)) {
    const [first, ...rest] = String(name).trim().split(/\s+/);
    const last = rest.length ? rest[rest.length - 1] : '';
    warnings.push(problem('name_mismatch', false, last
      ? `This address doesn't mention ${first} or ${last}`
      : `This address doesn't mention ${first}`));
  }
  return warnings;
}

/**
 * Every problem with putting `email` on a student row, blocking first.
 * @param {{ email: string, name: string, currentEmail: string|null, loginEmail: string|null,
 *           conflict: null | { kind, role?, sameSchool?, otherName?, otherGrade? } }} row
 * @param {{ domains: string[], forImport?: boolean }} opts forImport adds has_login
 */
function problemsFor(row, { domains, forImport = false }) {
  const email = String(row.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return [problem('invalid_email', true, "This isn't a valid email address.")];

  const out = [];
  if (forImport && row.loginEmail && String(row.loginEmail).toLowerCase() !== email) {
    out.push(problem('has_login', true, 'This student has an account. Change it with Edit email.'));
  }
  if (row.conflict) out.push(problem(row.conflict.kind, true, conflictMessage(row.conflict.kind, row.conflict)));
  out.push(...addressWarnings(email, row.name, domains));
  const current = row.currentEmail ? String(row.currentEmail).trim().toLowerCase() : null;
  if (current && current !== email) {
    out.push(problem('replaces_existing', false, `Replaces ${current}`, { defaultUnticked: true }));
  }
  return out;
}

const BATCH_SQL = `
SELECT i.idx::int AS idx, s.student_id, s.name, s.student_email AS current_email,
       lu.email AS login_email, cf.kind, cf.role, cf.same_school, cf.other_name, cf.other_grade
FROM unnest($1::uuid[], $2::text[]) WITH ORDINALITY AS i(student_id, email, idx)
JOIN students s ON s.student_id = i.student_id AND s.school = $3
LEFT JOIN student_account_links sal ON sal.student_id = s.student_id
LEFT JOIN users lu ON lu.user_id = sal.user_id
${conflictLateral('s', 'i.email', 'sal.user_id')}
ORDER BY i.idx`;

/**
 * Check many (student, address) pairs against the database in one query.
 * Pairs whose student isn't of the school are absent from the result.
 * @returns {Promise<Map<number, { studentId, name, currentEmail, hasLogin, problems }>>} keyed by the item's index
 */
async function checkStudentEmails({ school, domains, items, forImport = false }, client = db) {
  const out = new Map();
  if (items.length === 0) return out;
  const emails = items.map((it) => String(it.email || '').trim().toLowerCase());
  const { rows } = await client.query(BATCH_SQL, [items.map((it) => it.studentId), emails, school]);
  for (const r of rows) {
    const index = r.idx - 1;
    out.set(index, {
      studentId: r.student_id,
      name: r.name,
      currentEmail: r.current_email ?? null,
      hasLogin: Boolean(r.login_email),
      problems: problemsFor({
        email: emails[index],
        name: r.name,
        currentEmail: r.current_email,
        loginEmail: r.login_email,
        conflict: r.kind
          ? { kind: r.kind, role: r.role, sameSchool: r.same_school, otherName: r.other_name, otherGrade: r.other_grade }
          : null,
      }, { domains, forImport }),
    });
  }
  return out;
}

module.exports = {
  EMAIL_RE,
  isOutsideDomain,
  mentionsName,
  conflictMessage,
  conflictLateral,
  addressWarnings,
  problemsFor,
  checkStudentEmails,
};
