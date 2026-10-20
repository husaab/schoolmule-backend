// middleware/requireFormAccess.js
//
// Forms (RBAC D8): anyone on staff may build forms (e.g. a field-trip form)
// and manage the forms they created and their submissions; the `forms`
// permission opens every form of the school, registration included.
//
//   requireFormAccess('form')        :formId routes
//   requireFormAccess('submission')  :submissionId routes
//
// Holders of `forms` pass straight through (every controller already pins
// the form to the caller's school). Anyone else must be the form's creator;
// another school's form, or a missing one, is a 404.

const db = require('../config/database');
const logger = require('../logger');
const { withAccess } = require('./access');
const { can } = require('../services/access/access');

const SQL = {
  form: {
    param: 'formId',
    sql: `/* access:form */ SELECT created_by FROM registration_forms WHERE form_id = $1 AND school = $2`,
  },
  submission: {
    param: 'submissionId',
    sql: `/* access:form */
      SELECT f.created_by
        FROM registration_form_submissions s
        JOIN registration_forms f ON f.form_id = s.form_id
       WHERE s.submission_id = $1 AND f.school = $2`,
  },
};

const NOT_FOUND = { status: 'failed', message: 'Form not found' };

const requireFormAccess = (kind) => {
  const spec = SQL[kind];
  if (!spec) throw new Error(`requireFormAccess: unknown kind ${kind}`);
  return withAccess(async (req, res, next) => {
    if (!req.access.isStaffView) return res.status(403).json({ status: 'failed', message: 'Staff access required' });
    if (can(req, 'forms')) return next();
    try {
      const { rows } = await db.query(spec.sql, [req.params[spec.param], req.user.school]);
      if (rows.length === 0) return res.status(404).json(NOT_FOUND);
      if (rows[0].created_by !== req.user.userId) {
        return res.status(403).json({ status: 'failed', code: 'PERMISSION_DENIED', message: 'You can only manage the forms you created.' });
      }
      return next();
    } catch (error) {
      // A malformed id fails the uuid cast: read it as missing.
      logger.error({ err: error, kind }, 'Error verifying form ownership');
      return res.status(404).json(NOT_FOUND);
    }
  });
};

/** For list endpoints: null = every form of the school, else only the caller's own. */
const formCreatorFilter = (req) => (can(req, 'forms') ? null : req.user.userId);

module.exports = { requireFormAccess, formCreatorFilter };
