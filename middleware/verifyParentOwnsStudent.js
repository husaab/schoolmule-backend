// Guards /students/:studentId/* parent-portal routes: the logged-in parent
// must have a parent_students link to the requested student, otherwise 403.

const db = require('../config/database');
const parentStudentQueries = require('../queries/parentStudent.queries');
const logger = require('../logger');

const verifyParentOwnsStudent = async (req, res, next) => {
  const { studentId } = req.params;
  try {
    const { rows } = await db.query(parentStudentQueries.checkExistingRelation, [
      studentId,
      req.user.userId,
    ]);
    if (rows.length === 0) {
      return res.status(403).json({ status: 'failed', message: 'Not authorized for this student' });
    }
    next();
  } catch (error) {
    // A malformed studentId (invalid UUID) throws at the db layer — treat it
    // the same as an unauthorized probe rather than leaking a 500.
    logger.error('Error verifying parent-student link:', error);
    return res.status(403).json({ status: 'failed', message: 'Not authorized for this student' });
  }
};

module.exports = verifyParentOwnsStudent;
