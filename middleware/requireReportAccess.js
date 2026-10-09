// Ownership guards for the report-card and progress-report routes that a
// parent may read. Staff pass the student check untouched (the controllers
// already scope their queries to req.user.school); a parent must hold a
// parent_students link to the student. A signed URL is minted only for a
// path that is a report row of the caller's school and, for a parent, of a
// child they are linked to — so nobody can turn an arbitrary storage path
// into a download link.

const db = require('../config/database');
const parentStudentQueries = require('../queries/parentStudent.queries');
const logger = require('../logger');

const FORBIDDEN = { status: 'failed', message: 'Not authorized for this student' };

// Whitelisted tables; the name is interpolated so it must never come from input.
const OWNERSHIP_SQL = {
  report_cards: `
    SELECT 1 FROM report_cards r
    WHERE r.file_path = $1 AND r.school = $2
      AND ($3::uuid IS NULL OR EXISTS (
        SELECT 1 FROM parent_students ps WHERE ps.student_id = r.student_id AND ps.parent_id = $3))
    LIMIT 1
  `,
  progress_reports: `
    SELECT 1 FROM progress_reports r
    WHERE r.file_path = $1 AND r.school = $2
      AND ($3::uuid IS NULL OR EXISTS (
        SELECT 1 FROM parent_students ps WHERE ps.student_id = r.student_id AND ps.parent_id = $3))
    LIMIT 1
  `,
};

const isParent = (req) => req.user?.role === 'PARENT';

/**
 * Parent must be linked to the student named by `pickStudentId(req)`; staff
 * pass through.
 */
const requireStudentReportAccess = (pickStudentId) => async (req, res, next) => {
  if (!isParent(req)) return next();
  const studentId = pickStudentId(req);
  if (!studentId) return res.status(403).json(FORBIDDEN);
  try {
    const { rows } = await db.query(parentStudentQueries.checkExistingRelation, [studentId, req.user.userId]);
    if (rows.length === 0) return res.status(403).json(FORBIDDEN);
    next();
  } catch (error) {
    // A malformed id throws at the db layer; treat it like an unauthorized probe.
    logger.error({ err: error }, 'Error verifying parent-student link for report access');
    return res.status(403).json(FORBIDDEN);
  }
};

/**
 * `req.query.path` must be a row of `table` in the caller's school (and, for
 * a parent, of a linked child). Missing path is left to the handler's 400.
 */
const requireReportFileAccess = (table) => {
  const sql = OWNERSHIP_SQL[table];
  if (!sql) throw new Error(`requireReportFileAccess: unknown table ${table}`);
  return async (req, res, next) => {
    const { path } = req.query;
    if (!path) return next();
    try {
      const { rows } = await db.query(sql, [path, req.user.school, isParent(req) ? req.user.userId : null]);
      if (rows.length === 0) {
        return res.status(403).json({ status: 'failed', message: 'Not authorized for this file' });
      }
      next();
    } catch (error) {
      logger.error({ err: error }, 'Error verifying report file ownership');
      return res.status(403).json({ status: 'failed', message: 'Not authorized for this file' });
    }
  };
};

module.exports = { requireStudentReportAccess, requireReportFileAccess };
