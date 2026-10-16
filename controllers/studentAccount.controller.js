/*
  controllers/studentAccount.controller.js
  Admin Panel → Student accounts: list the year's students with their login
  status, invite them (after the admin confirms parental consent), fix their
  address, resend the invite or a password link, archive, relink a login to a
  new year's row, and delete. Admin only; the school always comes from the
  token, and every :studentId must be a student of that school (404 otherwise).
*/

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/studentAccount.queries');
const adminUserQueries = require('../queries/adminUser.queries');
const { GRADE_CODES } = require('../utils/gradeRank');
const { getSettings, MAX_NOTICE_VERSION } = require('../services/classroom/classroomSettings');
const {
  EMAIL_RE,
  ACCOUNT_STATUSES,
  normalizeEmail,
  conflictMessage,
  deriveStatus,
  toStudentAccountRow,
  loadSchoolInfo,
  inviteStudent,
  parseStudentIds,
  resendInviteFor,
  resetPasswordFor,
  issueQrCards,
  voidQr,
} = require('../services/classroom/studentAccounts');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INVITE_BATCH = 200;
// Resend allows ~2 requests/second; the same pause the publish digests use.
const EMAIL_GAP_MS = 600;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ok = (res, data, status = 200) => res.status(status).json({ status: 'success', data });
const failed = (res, status, message, extra = {}) => res.status(status).json({ status: 'failed', message, ...extra });
const has = (obj, key) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);

const NOT_FOUND = 'Student not found';
const NO_ACCOUNT = "This student doesn't have an account yet";

/** One StudentAccountRow for a student of the school, or null. */
async function loadRow(school, studentId) {
  const { rows } = await db.query(q.selectStudentAccountRow, [school, studentId]);
  return rows[0] || null;
}

async function respondWithRow(res, school, studentId) {
  const [row, settings] = await Promise.all([loadRow(school, studentId), getSettings(school)]);
  if (!row) return failed(res, 404, NOT_FOUND);
  return ok(res, toStudentAccountRow(row, settings));
}

// Runs fn(client) in a transaction on one pooled connection.
async function inTransaction(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// GET /api/admin/student-accounts?grade=&status=&q=
const listStudentAccounts = async (req, res) => {
  const { school } = req.user;
  const grade = typeof req.query.grade === 'string' ? req.query.grade.trim() : '';
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
  const term = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

  if (grade && !GRADE_CODES.includes(grade)) return failed(res, 400, 'Unknown grade');
  if (status && !ACCOUNT_STATUSES.includes(status)) return failed(res, 400, 'Unknown account status');

  try {
    const settings = await getSettings(school);
    const schoolYearId = req.schoolYear?.schoolYearId ?? null;
    const { rows } = schoolYearId
      ? await db.query(q.selectStudentAccountRows, [school, schoolYearId])
      : { rows: [] };

    const students = rows
      .map((row) => toStudentAccountRow(row, settings))
      .filter((s) => !grade || s.grade === grade)
      .filter((s) => !status || s.status === status)
      .filter((s) => !term || [s.name, s.studentEmail, s.account?.email]
        .some((v) => typeof v === 'string' && v.toLowerCase().includes(term)));

    return ok(res, { settings, students });
  } catch (error) {
    logger.error({ err: error }, 'Failed to list student accounts');
    return failed(res, 500, 'Error loading student accounts');
  }
};

// PATCH /api/admin/student-accounts/:studentId  { studentEmail: string | null }
// The student's own address. With an account, the sign-in address changes
// too (and any open invite/password link, sent to the old address, dies).
const updateStudentAccount = async (req, res) => {
  const { school } = req.user;
  const { studentId } = req.params;

  if (!has(req.body, 'studentEmail')) return failed(res, 400, 'studentEmail is required');
  const raw = req.body.studentEmail;
  if (raw !== null && typeof raw !== 'string') return failed(res, 400, 'Enter a valid email address');
  const email = normalizeEmail(raw);
  if (email && !EMAIL_RE.test(email)) return failed(res, 400, 'Enter a valid email address');

  try {
    const row = await loadRow(school, studentId);
    if (!row) return failed(res, 404, NOT_FOUND);

    if (!row.user_id) {
      await db.query(q.updateStudentEmail, [studentId, school, email]);
      return respondWithRow(res, school, studentId);
    }

    if (!email) {
      return failed(res, 400, 'A student with an account needs an email address. Delete the account to remove it.');
    }
    const { rows: others } = await db.query(q.selectOtherUserByEmail, [email, row.user_id]);
    if (others.length > 0) return failed(res, 409, 'An account already uses this email');
    // The same rule as the list and the invite: a login never moves onto a parent's address.
    const { rows: family } = await db.query(q.selectFamilyAddressMatch, [studentId, email]);
    if (family.length > 0) {
      return failed(res, 409, conflictMessage('family_address'), { code: 'FAMILY_ADDRESS' });
    }

    const changed = String(row.account_email || '').toLowerCase() !== email;
    try {
      await inTransaction(async (client) => {
        await client.query(q.updateStudentUserEmail, [row.user_id, school, email]);
        await client.query(q.updateStudentEmail, [studentId, school, email]);
        if (changed) await client.query(adminUserQueries.deleteTokensForUser, [row.user_id]);
      });
    } catch (error) {
      if (error.code === '23505') return failed(res, 409, 'An account already uses this email');
      throw error;
    }
    return respondWithRow(res, school, studentId);
  } catch (error) {
    logger.error({ err: error }, 'Failed to update a student email');
    return failed(res, 500, 'Error updating the student email');
  }
};

// POST /api/admin/student-accounts/invite  { studentIds, consentConfirmed: true, noticeVersion? }
const inviteStudents = async (req, res) => {
  const { school, userId, username } = req.user;
  const { studentIds, consentConfirmed, noticeVersion } = req.body ?? {};

  if (consentConfirmed !== true) {
    return failed(res, 400, 'Confirm you have parental consent before inviting students');
  }
  if (!Array.isArray(studentIds) || studentIds.length < 1 || studentIds.length > MAX_INVITE_BATCH) {
    return failed(res, 400, `Choose between 1 and ${MAX_INVITE_BATCH} students to invite`);
  }
  if (!studentIds.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
    return failed(res, 400, 'Invalid student id');
  }
  if (noticeVersion != null) {
    const v = typeof noticeVersion === 'string' ? noticeVersion.trim() : '';
    if (v.length < 1 || v.length > MAX_NOTICE_VERSION) {
      return failed(res, 400, `noticeVersion must be 1 to ${MAX_NOTICE_VERSION} characters`);
    }
  }

  const ids = [...new Set(studentIds.map((id) => id.toLowerCase()))];

  try {
    const settings = await getSettings(school);
    const version = noticeVersion != null ? noticeVersion.trim() : settings.consentNoticeVersion;

    // Only this school year's current rows (the year switcher's year).
    const schoolYearId = req.schoolYear?.schoolYearId ?? null;
    const { rows } = schoolYearId
      ? await db.query(q.selectStudentAccountRowsByIds, [school, ids, schoolYearId])
      : { rows: [] };
    if (rows.length !== ids.length) {
      return failed(res, 404, "Some of these students weren't found in this school year");
    }
    const byId = new Map(rows.map((r) => [r.student_id, r]));
    const schoolInfo = await loadSchoolInfo(school);
    const admin = { userId, username, school, schoolYearId };

    const results = [];
    for (let i = 0; i < ids.length; i += 1) {
      const result = await inviteStudent({ student: byId.get(ids[i]), settings, admin, noticeVersion: version, schoolInfo });
      results.push(result);
      if (result.outcome === 'invited' && i < ids.length - 1) await sleep(EMAIL_GAP_MS);
    }

    const invited = results.filter((r) => r.outcome === 'invited').length;
    return ok(res, { invited, skipped: results.length - invited, results });
  } catch (error) {
    logger.error({ err: error }, 'Failed to invite students');
    return failed(res, 500, 'Error inviting students');
  }
};

// The linked login of a student, or an error response already sent.
async function requireAccount(req, res) {
  const row = await loadRow(req.user.school, req.params.studentId);
  if (!row) { failed(res, 404, NOT_FOUND); return null; }
  if (!row.user_id) { failed(res, 400, NO_ACCOUNT); return null; }
  return row;
}

const sentOrRefused = (res, result) => (result.sent ? ok(res, { sent: true }) : failed(res, result.status, result.message));

// POST /api/admin/student-accounts/:studentId/resend-invite
const resendInvite = async (req, res) => {
  const { school, username } = req.user;
  try {
    const row = await requireAccount(req, res);
    if (!row) return undefined;
    return sentOrRefused(res, await resendInviteFor(row, { school, invitedBy: username }));
  } catch (error) {
    logger.error({ err: error }, 'Failed to resend a student invite');
    return failed(res, 500, 'Error resending the invite');
  }
};

// POST /api/admin/student-accounts/:studentId/reset-password
const resetPassword = async (req, res) => {
  const { school, username } = req.user;
  try {
    const row = await requireAccount(req, res);
    if (!row) return undefined;
    return sentOrRefused(res, await resetPasswordFor(row, { school, requestedBy: username }));
  } catch (error) {
    logger.error({ err: error }, 'Failed to send a student password link');
    return failed(res, 500, 'Error sending the password link');
  }
};

// POST /api/admin/student-accounts/qr/void  { studentIds }
// The listed students' live QR cards stop working (a reprint issues new ones).
const voidQrCards = async (req, res) => {
  const parsed = parseStudentIds(req.body?.studentIds);
  if (parsed.error) return failed(res, 400, parsed.error);
  try {
    return ok(res, { voided: await voidQr({ school: req.user.school, studentIds: parsed.ids }) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to void student QR cards');
    return failed(res, 500, 'Error voiding the QR cards');
  }
};

/**
 * Send a cards PDF from issueQrCards. Ineligible students are listed in
 * X-Skipped-Students; nothing printable is a 404. Shared with the teacher's
 * class route (controllers/classroom.controller.js).
 */
async function sendQrCards(res, { school, studentIds, requestedBy }) {
  const { pdf, skippedIds } = await issueQrCards({ school, studentIds, requestedBy });
  if (!pdf) {
    return failed(res, 404, 'None of these students can get a QR card. Cards are for invited or active accounts in the QR grades.', {
      skippedStudentIds: skippedIds,
    });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="student-sign-in-cards.pdf"');
  res.setHeader('Content-Length', pdf.length);
  if (skippedIds.length > 0) res.setHeader('X-Skipped-Students', skippedIds.join(','));
  return res.status(200).send(Buffer.from(pdf));
}

// POST /api/admin/student-accounts/cards.pdf  { studentIds }
// Printing always reissues: each printed card voids that student's older one.
const printQrCards = async (req, res) => {
  const parsed = parseStudentIds(req.body?.studentIds);
  if (parsed.error) return failed(res, 400, parsed.error);
  try {
    return await sendQrCards(res, { school: req.user.school, studentIds: parsed.ids, requestedBy: req.user.userId });
  } catch (error) {
    logger.error({ err: error }, 'Failed to print student QR cards');
    return failed(res, 500, 'Error printing the QR cards');
  }
};

// POST /api/admin/student-accounts/:studentId/archive
// Keeps every record; the login stops working, open links die, the QR card is voided.
const archiveAccount = async (req, res) => {
  const { school, userId: adminId } = req.user;
  try {
    const row = await requireAccount(req, res);
    if (!row) return undefined;
    if (row.is_archived) return failed(res, 409, 'This account is already archived');

    const archived = await inTransaction(async (client) => {
      const { rows } = await client.query(q.archiveStudentUser, [row.user_id, school, adminId]);
      if (rows.length === 0) return false;
      await client.query(adminUserQueries.deleteTokensForUser, [row.user_id]);
      await client.query(q.voidQr, [row.user_id]);
      return true;
    });
    if (!archived) return failed(res, 409, 'This account is already archived');
    return respondWithRow(res, school, req.params.studentId);
  } catch (error) {
    logger.error({ err: error }, 'Failed to archive a student account');
    return failed(res, 500, 'Error archiving the account');
  }
};

// POST /api/admin/student-accounts/:studentId/unarchive
// Restores sign-in. A voided QR card stays voided (print a new one).
const unarchiveAccount = async (req, res) => {
  const { school } = req.user;
  try {
    const row = await requireAccount(req, res);
    if (!row) return undefined;
    if (!row.is_archived) return failed(res, 409, "This account isn't archived");

    const { rows } = await db.query(q.unarchiveStudentUser, [row.user_id, school]);
    if (rows.length === 0) return failed(res, 409, "This account isn't archived");
    return respondWithRow(res, school, req.params.studentId);
  } catch (error) {
    logger.error({ err: error }, 'Failed to restore a student account');
    return failed(res, 500, 'Error restoring the account');
  }
};

// GET /api/admin/student-accounts/unlinked
// Student logins with no student row this school year (after a transfer or
// re-enrolment), for the relink picker.
const listUnlinked = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectUnlinkedStudentUsers, [req.user.school, req.schoolYear?.schoolYearId ?? null]);
    return ok(res, rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      email: r.email,
      lastSchoolYearLabel: r.last_school_year_label ?? null,
    })));
  } catch (error) {
    logger.error({ err: error }, 'Failed to list unlinked student accounts');
    return failed(res, 500, 'Error loading student accounts');
  }
};

// POST /api/admin/student-accounts/:studentId/link  { userId }
const linkAccount = async (req, res) => {
  const { school, userId: adminId } = req.user;
  const { studentId } = req.params;
  const targetId = req.body?.userId;

  if (typeof targetId !== 'string' || !UUID_RE.test(targetId)) {
    return failed(res, 400, 'Choose the student account to link');
  }

  try {
    const row = await loadRow(school, studentId);
    if (!row) return failed(res, 404, NOT_FOUND);
    const { rows: users } = await db.query(q.selectStudentUserInSchool, [targetId, school]);
    if (users.length === 0) return failed(res, 404, 'Student account not found');
    if (row.user_id) return failed(res, 409, 'This student is already linked to an account');

    const schoolYearId = row.school_year_id || req.schoolYear?.schoolYearId || null;
    if (!schoolYearId) return failed(res, 400, "This student isn't in a school year");
    const { rows: existing } = await db.query(q.selectLinkForUserYear, [targetId, schoolYearId]);
    if (existing.length > 0) {
      return failed(res, 409, 'This account is already linked to a student in this school year');
    }

    try {
      await inTransaction(async (client) => {
        await client.query(q.insertStudentAccountLink, [targetId, studentId, schoolYearId, adminId]);
        await client.query(q.fillBlankStudentEmail, [studentId, users[0].email]);
      });
    } catch (error) {
      if (error.code === '23505') return failed(res, 409, 'This student or account is already linked this school year');
      throw error;
    }
    return respondWithRow(res, school, studentId);
  } catch (error) {
    logger.error({ err: error }, 'Failed to link a student account');
    return failed(res, 500, 'Error linking the account');
  }
};

// DELETE /api/admin/student-accounts/:studentId/link
// The login is kept (it can be linked again); only this year's link goes.
const unlinkAccount = async (req, res) => {
  const { school } = req.user;
  const { studentId } = req.params;
  try {
    const row = await loadRow(school, studentId);
    if (!row) return failed(res, 404, NOT_FOUND);
    if (!row.user_id) return failed(res, 404, 'No account is linked to this student');

    await db.query(q.deleteLinkByStudent, [studentId]);
    return respondWithRow(res, school, studentId);
  } catch (error) {
    logger.error({ err: error }, 'Failed to unlink a student account');
    return failed(res, 500, 'Error unlinking the account');
  }
};

// DELETE /api/admin/student-accounts/:studentId/account
// Removes the login with its consent record and every year's link. An active
// account is archived first, so a delete is never the first step.
const deleteAccount = async (req, res) => {
  const { school } = req.user;
  try {
    const row = await loadRow(school, req.params.studentId);
    if (!row) return failed(res, 404, NOT_FOUND);
    if (!row.user_id) return failed(res, 404, NO_ACCOUNT);

    const settings = await getSettings(school);
    if (deriveStatus(row, settings) === 'active') return failed(res, 409, 'Archive the account first');

    try {
      const result = await db.query(q.deleteStudentUser, [row.user_id, school]);
      if (result.rowCount === 0) return failed(res, 404, NO_ACCOUNT);
    } catch (error) {
      if (error.code === '23503') {
        return failed(res, 409, 'Other records still point at this account. Keep it archived instead.');
      }
      throw error;
    }
    return ok(res, { deleted: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete a student account');
    return failed(res, 500, 'Error deleting the account');
  }
};

module.exports = {
  listStudentAccounts,
  updateStudentAccount,
  inviteStudents,
  resendInvite,
  resetPassword,
  voidQrCards,
  printQrCards,
  sendQrCards,
  archiveAccount,
  unarchiveAccount,
  listUnlinked,
  linkAccount,
  unlinkAccount,
  deleteAccount,
};
