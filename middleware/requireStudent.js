// The student portal's one choke point: the caller must be a STUDENT linked to
// a non-archived student row in the request's school year. Every /api/student
// query keys on req.student.studentId — never on an id from the client.
//
// It also re-checks the two things that can change during a 12-hour session:
// an archived login (401, the client signs out) and a school that turned
// classrooms off (403 CLASSROOM_DISABLED). Consent and grade are checked at
// sign-in and on every /api/auth/me.

const db = require('../config/database');
const logger = require('../logger');
const { MESSAGES } = require('../services/classroom/studentLogin');

const SQL = `
  SELECT s.student_id, s.name, s.grade::text AS grade, s.school_year_id,
         u.is_archived AS user_archived, scs.enabled AS classrooms_enabled
  FROM student_account_links sal
  JOIN students s ON s.student_id = sal.student_id
  JOIN users u ON u.user_id = sal.user_id
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
    if (!r.classrooms_enabled) {
      return res.status(403).json({ status: 'failed', code: 'CLASSROOM_DISABLED', message: MESSAGES.CLASSROOM_DISABLED });
    }
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
