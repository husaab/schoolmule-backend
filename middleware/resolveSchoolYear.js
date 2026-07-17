const db = require('../config/database');
const schoolYearQueries = require('../queries/schoolYear.queries');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolves the school-year context for every authenticated request.
// Header X-School-Year (a school_year_id) selects a year explicitly;
// otherwise the school's active year is used. Non-admins may only read
// (GET) years that are not active.
const resolveSchoolYear = async (req, res, next) => {
  try {
    const headerYearId = req.headers['x-school-year'];
    let year = null;

    if (headerYearId) {
      if (!UUID_RE.test(headerYearId)) {
        return res.status(400).json({ status: 'failed', message: 'Invalid X-School-Year header' });
      }
      const { rows } = await db.query(schoolYearQueries.selectYearById, [headerYearId]);
      if (rows.length === 0) {
        return res.status(400).json({ status: 'failed', message: 'Unknown school year' });
      }
      if (rows[0].school !== req.user.school) {
        return res.status(403).json({ status: 'failed', message: 'School year does not belong to your school' });
      }
      year = rows[0];
    } else {
      const { rows } = await db.query(schoolYearQueries.selectActiveYearBySchool, [req.user.school]);
      year = rows[0] || null;
    }

    if (!year) {
      // School has no configured years (e.g. brand-new tenant). Reads proceed
      // with no year context; writes need a year to attach data to.
      if (req.method !== 'GET') {
        return res.status(400).json({ status: 'failed', message: 'No school year configured for your school' });
      }
      req.schoolYear = null;
      return next();
    }

    req.schoolYear = {
      schoolYearId: year.school_year_id,
      label: year.label,
      isActive: year.is_active,
    };

    if (!year.is_active && req.user.role !== 'ADMIN' && req.method !== 'GET') {
      return res.status(403).json({
        status: 'failed',
        message: `${year.label} is read-only: only admins can modify a past school year`,
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

module.exports = resolveSchoolYear;
