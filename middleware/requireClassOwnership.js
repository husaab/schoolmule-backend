// Guards routes carrying a :classId that mutate or expose a class's data.
//
// The class must be in the caller's school and the caller must be a staff
// view that teaches it (classes.teacher_id, or a co-teacher row in
// class_teachers) or holds classes.all (RBAC, middleware/access.js).
// requireClassOwnership.or('attendance.classes') also lets in holders of the
// given keys: class attendance for every class without the gradebook.
//
// On success: req.class = { classId, school, teacherId }.

const db = require('../config/database');
const logger = require('../logger');
const { withAccess, classAccessGranted } = require('./access');
const { assertKey } = require('../services/access/access');

const NOT_AUTHORIZED = { status: 'failed', message: 'Not authorized for this class' };

const makeClassGuard = (extraKeys = []) => {
  extraKeys.forEach(assertKey);
  return withAccess(async (req, res, next) => {
    const { classId } = req.params;

    try {
      const { rows } = await db.query(
        `SELECT
           c.class_id,
           c.school,
           c.teacher_id,
           EXISTS (
             SELECT 1 FROM class_teachers ct
             WHERE ct.class_id = c.class_id AND ct.teacher_id = $2
           ) AS is_co_teacher
         FROM classes AS c
         WHERE c.class_id = $1`,
        [classId, req.user.userId],
      );

      if (rows.length === 0) {
        return res.status(404).json({ status: 'failed', message: 'Class not found' });
      }

      const cls = rows[0];
      if (!classAccessGranted(req, cls, extraKeys)) {
        return res.status(403).json(NOT_AUTHORIZED);
      }

      req.class = { classId: cls.class_id, school: cls.school, teacherId: cls.teacher_id };
      return next();
    } catch (error) {
      // A malformed classId (invalid UUID) throws at the db layer — treat it
      // as an unauthorized probe rather than leaking a 500, matching
      // verifyParentOwnsStudent.
      logger.error('Error verifying class ownership:', error);
      return res.status(403).json(NOT_AUTHORIZED);
    }
  });
};

const requireClassOwnership = makeClassGuard();
requireClassOwnership.or = (...keys) => makeClassGuard(keys);

module.exports = requireClassOwnership;
