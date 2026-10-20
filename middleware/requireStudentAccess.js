// middleware/requireStudentAccess.js
//
// Per-student routes that are not tied to one class (the JK/SK gradebook,
// report generation). Every student the request names must be in the
// caller's school, and the caller must teach them (lead or co-teacher of a
// class they're enrolled in, or their homeroom teacher), hold classes.all,
// or hold one of `keys` (report_cards for generating reports).
//
//   requireStudentAccess({ studentIds: (req) => [...], keys: ['report_cards'] })
//
// With no ids it passes, so the controller's own 400 still answers.

const db = require('../config/database');
const logger = require('../logger');
const { withAccess } = require('./access');
const { assertKey, can } = require('../services/access/access');

const FORBIDDEN = { status: 'failed', message: 'Not authorized for this student' };

// $1 student ids, $2 caller
const SQL = `/* access:students */
  SELECT s.student_id, s.school,
         (s.homeroom_teacher_id = $2
          OR EXISTS (
            SELECT 1 FROM class_students cs
              JOIN classes c ON c.class_id = cs.class_id
             WHERE cs.student_id = s.student_id
               AND (c.teacher_id = $2
                    OR EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $2))
          )) AS taught
    FROM students s
   WHERE s.student_id = ANY($1::uuid[])`;

const distinctIds = (list) => [...new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === 'string' && id))];

const requireStudentAccess = ({ studentIds = () => [], keys = [] } = {}) => {
  keys.forEach(assertKey);
  return withAccess(async (req, res, next) => {
    if (!req.access.isStaffView) return res.status(403).json(FORBIDDEN);
    const ids = distinctIds(studentIds(req));
    if (ids.length === 0) return next();

    try {
      const { rows } = await db.query(SQL, [ids, req.user.userId]);
      if (rows.length < ids.length) return res.status(404).json({ status: 'failed', message: 'Student not found' });
      if (rows.some((s) => String(s.school) !== String(req.user.school))) return res.status(403).json(FORBIDDEN);
      const wide = can(req, 'classes.all') || keys.some((k) => can(req, k));
      if (!wide && !rows.every((s) => s.taught)) return res.status(403).json(FORBIDDEN);
      return next();
    } catch (error) {
      // A malformed id fails the uuid cast: an unauthorized probe, not a 500.
      logger.error({ err: error }, 'Error verifying student access');
      return res.status(403).json(FORBIDDEN);
    }
  });
};

module.exports = requireStudentAccess;
module.exports.SQL = SQL;
