// middleware/requireGradebookAccess.js
//
// Gradebook routes addressed by assessment ids, or by class ids in the body,
// instead of a :classId (which requireClassOwnership covers). Every class the
// request touches must pass the class rule (middleware/access.js
// classAccessGranted): in the caller's school, and taught by them or open to
// them through classes.all. One unknown id is a 404 for the whole request.
//
//   requireGradebookAccess({
//     classIds: (req) => [...],       // class ids named in the request
//     assessmentIds: (req) => [...],  // assessment ids named in the request
//     keys: ['report_cards'],         // also let holders of these keys in
//   })
//
// With no ids at all it passes, so the controller's own 400 still answers.
// When exactly one class is touched, req.class is set like requireClassOwnership.

const db = require('../config/database');
const logger = require('../logger');
const { withAccess, classAccessGranted } = require('./access');
const { assertKey } = require('../services/access/access');

const NOT_AUTHORIZED = { status: 'failed', message: 'Not authorized for this class' };

// $1 class ids, $2 assessment ids, $3 caller
const SQL = `/* access:gradebook */
  WITH wanted AS (
    SELECT class_id FROM classes WHERE class_id = ANY($1::uuid[])
    UNION
    SELECT class_id FROM assessments WHERE assessment_id = ANY($2::uuid[])
  )
  SELECT c.class_id, c.school, c.teacher_id,
         EXISTS (SELECT 1 FROM class_teachers ct WHERE ct.class_id = c.class_id AND ct.teacher_id = $3) AS is_co_teacher,
         (SELECT COUNT(*)::int FROM classes WHERE class_id = ANY($1::uuid[])) AS classes_found,
         (SELECT COUNT(*)::int FROM assessments WHERE assessment_id = ANY($2::uuid[])) AS assessments_found
    FROM classes c
   WHERE c.class_id IN (SELECT class_id FROM wanted)`;

const distinctIds = (list) => [...new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === 'string' && id))];

const requireGradebookAccess = ({ classIds = () => [], assessmentIds = () => [], keys = [] } = {}) => {
  keys.forEach(assertKey);
  return withAccess(async (req, res, next) => {
    const cIds = distinctIds(classIds(req));
    const aIds = distinctIds(assessmentIds(req));
    if (cIds.length === 0 && aIds.length === 0) return next();

    try {
      const { rows } = await db.query(SQL, [cIds, aIds, req.user.userId]);
      const found = rows[0];
      if (!found || found.classes_found < cIds.length || found.assessments_found < aIds.length) {
        return res.status(404).json({ status: 'failed', message: 'Not found' });
      }
      if (!rows.every((cls) => classAccessGranted(req, cls, keys))) return res.status(403).json(NOT_AUTHORIZED);

      if (rows.length === 1) {
        req.class = { classId: found.class_id, school: found.school, teacherId: found.teacher_id };
      }
      return next();
    } catch (error) {
      // A malformed id fails the uuid cast: an unauthorized probe, not a 500.
      logger.error({ err: error }, 'Error verifying gradebook access');
      return res.status(403).json(NOT_AUTHORIZED);
    }
  });
};

module.exports = requireGradebookAccess;
module.exports.SQL = SQL;
