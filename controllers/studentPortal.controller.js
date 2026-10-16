/*
  controllers/studentPortal.controller.js
  The student portal API (/api/student). requireStudent runs first: every
  handler reads the caller's own student row from req.student and never takes
  a student id from the client.
*/

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/studentAccount.queries');
const { getSettings } = require('../services/classroom/classroomSettings');
const { loadSchoolInfo } = require('../services/classroom/studentAccounts');
const { getSchoolName } = require('../utils/schoolUtils');

const ok = (res, data) => res.status(200).json({ status: 'success', data });
const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });

// GET /api/student/me
// Who is signed in: the student row for the request year, the login, the
// school and the settings the portal shell needs.
const getMe = async (req, res) => {
  const { school, userId } = req.user;
  try {
    const [{ rows }, schoolInfo, settings] = await Promise.all([
      db.query(q.selectStudentUserEmail, [userId]),
      loadSchoolInfo(school),
      getSettings(school),
    ]);
    const { studentId, name, firstName, grade, schoolYearId } = req.student;
    return ok(res, {
      student: { studentId, name, firstName, grade },
      user: { userId, email: rows[0]?.email ?? req.user.email ?? null },
      school: { code: school, name: (schoolInfo && schoolInfo.name) || getSchoolName(String(school)) },
      settings: { studentPhotos: settings.studentPhotos },
      schoolYear: { schoolYearId, label: req.schoolYear?.label ?? null },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load the student portal profile');
    return failed(res, 500, 'Error loading your account');
  }
};

module.exports = { getMe };
