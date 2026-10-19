// The student portal's one choke point: the caller must be a STUDENT linked to
// a non-archived student row in the request's school year. Every /api/student
// query keys on req.student.studentId — never on an id from the client.
//
// It also re-checks what can change during a 12-hour session, in the one
// query it runs: an archived login (401, the client signs out), a session
// opened with a QR card that has since been voided or reprinted (401
// QR_INVALID), a school that turned classrooms off (403 CLASSROOM_DISABLED),
// and the sign-in gate's consent and grade (Fable M6): consent withdrawn
// (401 CONSENT_REQUIRED) or the school's sign-in grade raised above the
// student's (401 GRADE_NOT_ENABLED), as /api/auth/me answers.

const db = require('../config/database');
const logger = require('../logger');
const { MESSAGES, qrCardLive, consentGradeVerdict } = require('../services/classroom/studentLogin');

const SQL = `
  SELECT s.student_id, s.name, s.grade::text AS grade, s.school_year_id,
         u.is_archived AS user_archived, scs.enabled AS classrooms_enabled, scs.login_from_grade,
         sa.qr_secret_hash, sa.qr_voided_at, sa.consent_at
  FROM student_account_links sal
  JOIN students s ON s.student_id = sal.student_id
  JOIN users u ON u.user_id = sal.user_id
  LEFT JOIN student_accounts sa ON sa.user_id = sal.user_id
  LEFT JOIN school_classroom_settings scs ON scs.school = s.school
  WHERE sal.user_id = $1 AND sal.school_year_id = $2 AND s.school = $3 AND s.is_archived IS NOT TRUE`;

module.exports = async function requireStudent(req, res, next) {
  if (req.user?.role !== 'STUDENT') return res.status(403).json({ status: 'failed', message: 'Student access required' });
  try {
    const yearId = req.schoolYear?.schoolYearId ?? null;
    const { rows } = yearId ? await db.query(SQL, [req.user.userId, yearId, req.user.school]) : { rows: [] };
    if (!rows[0]) return res.status(403).json({ status: 'failed', code: 'NO_STUDENT_LINK', message: MESSAGES.NO_STUDENT_LINK });
    const r = rows[0];
    if (r.user_archived) return res.status(401).json({ status: 'failed', message: 'This account has been archived' });
    if (!qrCardLive(req.user.qrCard, { qrSecretHash: r.qr_secret_hash, qrVoidedAt: r.qr_voided_at })) {
      return res.status(401).json({ status: 'failed', code: 'QR_INVALID', message: MESSAGES.QR_INVALID });
    }
    if (!r.classrooms_enabled) {
      return res.status(403).json({ status: 'failed', code: 'CLASSROOM_DISABLED', message: MESSAGES.CLASSROOM_DISABLED });
    }
    const gate = consentGradeVerdict({ consentAt: r.consent_at, grade: r.grade, loginFromGrade: r.login_from_grade });
    if (gate) return res.status(401).json({ status: 'failed', code: gate.code, message: gate.message });
    req.student = {
      studentId: r.student_id,
      name: r.name,
      firstName: String(r.name).trim().split(/\s+/)[0],
      grade: r.grade,
      schoolYearId: r.school_year_id,
      userId: req.user.userId,
    };
    return next();
  } catch (error) {
    logger.error({ err: error }, 'requireStudent failed');
    return res.status(403).json({ status: 'failed', message: 'Student access required' });
  }
};
