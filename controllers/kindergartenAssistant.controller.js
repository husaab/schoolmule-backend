/*
  controllers/kindergartenAssistant.controller.js
  The JK/SK gradebook's teacher-assistant picker (/api/jk|sk/teacher-assistant).
  The assistant is a co-teacher of the student's Kindergarten class; see
  services/kindergartenStaff.js for the rule. Both routes sit behind
  requireStudentAccess (teachers and co-teachers of the student, classes.all).

  GET  /teacher-assistant/:studentId?term=  -> assistantInfo
  POST /teacher-assistant  { studentId, term, mode: 'default'|'none'|'user', assistantUserId? } -> assistantInfo
       A body without `mode` (an app version that still sends a typed name)
       changes nothing and answers with the current choice.
*/

const db = require('../config/database');
const logger = require('../logger');
const studentQueries = require('../queries/student.queries');
const { can } = require('../services/access/access');
const staffService = require('../services/kindergartenStaff');

const ok = (res, data) => res.status(200).json({ status: 'success', data });
const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });

/** Can the caller add co-teachers to the class (Class → Settings → Teachers)? */
const managesClass = (req, staff) => staff.classMemberIds.includes(req.user.userId)
  || can(req, 'classes.manage') || can(req, 'classes.all');

async function loadStaff(req, grade, studentId, term) {
  const { rows } = await db.query(studentQueries.selectStudentById, [studentId]);
  if (!rows[0]) return null;
  const staff = await staffService.resolveKindergartenStaff(db, rows[0], {
    term,
    schoolYearId: req.schoolYear?.schoolYearId || null,
    grade,
  });
  return { student: rows[0], staff };
}

const getTeacherAssistant = (grade) => async (req, res) => {
  const { studentId } = req.params;
  const { term } = req.query;
  if (!term) return failed(res, 400, 'term is required');
  try {
    const loaded = await loadStaff(req, grade, studentId, term);
    if (!loaded) return failed(res, 404, 'Student not found');
    return ok(res, staffService.assistantInfo(loaded.staff, { canManageClass: managesClass(req, loaded.staff) }));
  } catch (error) {
    logger.error({ err: error, grade }, 'Error loading the teacher assistant');
    return failed(res, 500, 'Failed to load the teacher assistant');
  }
};

const saveTeacherAssistant = (grade) => async (req, res) => {
  const { studentId, term } = req.body || {};
  if (!studentId || !term) return failed(res, 400, 'studentId and term are required');
  const choice = staffService.parseAssistantChoice(req.body);
  if (choice?.error) return failed(res, 400, choice.error);
  try {
    const loaded = await loadStaff(req, grade, studentId, term);
    if (!loaded) return failed(res, 404, 'Student not found');
    if (!choice) {
      logger.info({ grade }, 'Ignored a typed teacher-assistant name (an older app version)');
      return ok(res, staffService.assistantInfo(loaded.staff, { canManageClass: managesClass(req, loaded.staff) }));
    }
    const saved = await staffService.saveAssistantChoice(db, {
      staff: loaded.staff, studentId, term, school: loaded.student.school, choice,
    });
    if (saved.error) return failed(res, 400, saved.error);
    const fresh = await loadStaff(req, grade, studentId, term);
    return ok(res, staffService.assistantInfo(fresh.staff, { canManageClass: managesClass(req, fresh.staff) }));
  } catch (error) {
    logger.error({ err: error, grade }, 'Error saving the teacher assistant');
    return failed(res, 500, 'Failed to save the teacher assistant');
  }
};

module.exports = { getTeacherAssistant, saveTeacherAssistant };
