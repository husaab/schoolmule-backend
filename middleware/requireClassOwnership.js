// Guards routes carrying a :classId that mutate or expose a class's data.
//
// Verifies the class belongs to the caller's school and — for TEACHER, not
// ADMIN — that the caller actually teaches it (classes.teacher_id, or a
// co-teacher row in class_teachers).
//
// Note this is the first ownership check of its kind in the codebase:
// assessment.controller.js and studentAssessment.controller.js currently do
// no school or ownership verification at all. The closest existing check
// (studentAssessment.controller.js, upsertScoresByClass) only validates that
// an assessment_id belongs to a class_id — integrity, not authorization.
// Worth retrofitting this onto those routes as a follow-up.
//
// On success: req.class = { classId, school, teacherId }.

const db = require('../config/database');
const logger = require('../logger');

const NOT_AUTHORIZED = { status: 'failed', message: 'Not authorized for this class' };

const requireClassOwnership = async (req, res, next) => {
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

    if (cls.school !== req.user.school) {
      return res.status(403).json(NOT_AUTHORIZED);
    }

    if (req.user.role === 'TEACHER') {
      if (cls.teacher_id !== req.user.userId && !cls.is_co_teacher) {
        return res.status(403).json(NOT_AUTHORIZED);
      }
    } else if (req.user.role !== 'ADMIN') {
      // Parents and any future role have no business here.
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
};

module.exports = requireClassOwnership;
