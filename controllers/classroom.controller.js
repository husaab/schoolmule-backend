/*
  controllers/classroom.controller.js
  The teacher's classroom API (/api/classroom). requireStaff runs for the
  whole router and requireClassOwnership on every :classId route, so a
  teacher reaches only classes they teach (admins reach any class of their
  school). Student actions also require the student to be on that class's
  roster: a teacher manages only their own students' logins.
*/

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/studentAccount.queries');
const { parseStudentIds, resendInviteFor, resetPasswordFor } = require('../services/classroom/studentAccounts');
const { sendQrCards } = require('./studentAccount.controller');

const ok = (res, data) => res.status(200).json({ status: 'success', data });
const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });

/** The subset of these student ids on the class roster. */
async function enrolledIn(classId, studentIds) {
  const { rows } = await db.query(q.selectEnrolledStudentIds, [classId, studentIds]);
  return new Set(rows.map((r) => r.student_id));
}

// One student's login action, for a student on the class roster.
const studentAccountAction = (run, what) => async (req, res) => {
  const { school, username } = req.user;
  const { classId } = req.params;
  const studentId = req.params.studentId.toLowerCase();
  try {
    if (!(await enrolledIn(classId, [studentId])).has(studentId)) {
      return failed(res, 403, "This student isn't in this class");
    }
    const { rows } = await db.query(q.selectStudentAccountRow, [school, studentId]);
    const row = rows[0];
    if (!row) return failed(res, 404, 'Student not found');
    if (!row.user_id) return failed(res, 400, "This student doesn't have an account yet");

    const result = await run(row, { school, by: username });
    return result.sent ? ok(res, { sent: true }) : failed(res, result.status, result.message);
  } catch (error) {
    logger.error({ err: error, classId, studentId }, `Failed to ${what}`);
    return failed(res, 500, `Error trying to ${what}`);
  }
};

// POST /api/classroom/classes/:classId/students/:studentId/reset-password
const resetStudentPassword = studentAccountAction(
  (row, { school, by }) => resetPasswordFor(row, { school, requestedBy: by }),
  "send a student's password link",
);

// POST /api/classroom/classes/:classId/students/:studentId/resend-invite
const resendStudentInvite = studentAccountAction(
  (row, { school, by }) => resendInviteFor(row, { school, invitedBy: by }),
  "resend a student's invite",
);

// POST /api/classroom/classes/:classId/qr-cards.pdf  { studentIds }
// Every student must be on this class's roster (403 otherwise). Printing
// always reissues: each printed card voids that student's older one.
const printClassQrCards = async (req, res) => {
  const parsed = parseStudentIds(req.body?.studentIds);
  if (parsed.error) return failed(res, 400, parsed.error);
  try {
    const enrolled = await enrolledIn(req.params.classId, parsed.ids);
    if (parsed.ids.some((id) => !enrolled.has(id))) {
      return failed(res, 403, "Some of these students aren't in this class");
    }
    return await sendQrCards(res, { school: req.user.school, studentIds: parsed.ids, requestedBy: req.user.userId });
  } catch (error) {
    logger.error({ err: error, classId: req.params.classId }, 'Failed to print class QR cards');
    return failed(res, 500, 'Error printing the QR cards');
  }
};

module.exports = { resetStudentPassword, resendStudentInvite, printClassQrCards };
