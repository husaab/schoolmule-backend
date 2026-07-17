const db = require('../config/database');
const schoolYearQueries = require('../queries/schoolYear.queries');
const termQueries = require('../queries/term.queries');
const logger = require('../logger');

const LABEL_RE = /^\d{4}-\d{4}$/;

const mapYear = (r) => ({
  schoolYearId: r.school_year_id,
  school: r.school,
  schoolId: r.school_id,
  label: r.label,
  startDate: r.start_date,
  endDate: r.end_date,
  isActive: r.is_active,
  createdFromYearId: r.created_from_year_id,
});

async function resolveSchoolId(school) {
  const { rows } = await db.query('SELECT school_id FROM schools WHERE school_code = $1', [school]);
  return rows[0]?.school_id || null;
}

const getSchoolYears = async (req, res, next) => {
  try {
    const { rows } = await db.query(schoolYearQueries.selectYearsBySchool, [req.user.school]);
    return res.status(200).json({ status: 'success', data: rows.map(mapYear) });
  } catch (error) { next(error); }
};

const createSchoolYear = async (req, res, next) => {
  try {
    const { label, startDate, endDate } = req.body;
    if (!label || !LABEL_RE.test(label)) {
      return res.status(400).json({ status: 'failed', message: 'label must look like 2026-2027' });
    }
    if (!startDate || !endDate) {
      return res.status(400).json({ status: 'failed', message: 'startDate and endDate are required' });
    }
    const schoolId = await resolveSchoolId(req.user.school);
    if (!schoolId) {
      return res.status(400).json({ status: 'failed', message: 'School is not registered' });
    }
    const active = await db.query(schoolYearQueries.selectActiveYearBySchool, [req.user.school]);
    // Bootstrap case: a brand-new school has no active year yet (first year
    // ever created for it). That year must be usable immediately, so make
    // it active on creation instead of leaving it a draft with nothing to
    // activate it from. Every subsequent year still starts as a draft.
    const isBootstrap = !active.rows[0];
    const createdFrom = isBootstrap ? null : active.rows[0].school_year_id;
    const { rows } = await db.query(schoolYearQueries.insertYear,
      [req.user.school, schoolId, label, startDate, endDate, isBootstrap, createdFrom]);
    return res.status(201).json({ status: 'success', data: mapYear(rows[0]) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ status: 'failed', message: 'A school year with that label already exists' });
    }
    next(error);
  }
};

const updateSchoolYear = async (req, res, next) => {
  try {
    const { label, startDate, endDate } = req.body;
    if (!label || !LABEL_RE.test(label)) {
      return res.status(400).json({ status: 'failed', message: 'label must look like 2026-2027' });
    }
    const existing = await db.query(schoolYearQueries.selectYearById, [req.params.id]);
    if (existing.rows.length === 0 || existing.rows[0].school !== req.user.school) {
      return res.status(404).json({ status: 'failed', message: 'School year not found' });
    }
    const { rows } = await db.query(schoolYearQueries.updateYear,
      [req.params.id, label, startDate, endDate]);
    return res.status(200).json({ status: 'success', data: mapYear(rows[0]) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ status: 'failed', message: 'A school year with that label already exists' });
    }
    next(error);
  }
};

const activateSchoolYear = async (req, res, next) => {
  const client = await db.connect();
  try {
    const existing = await client.query(schoolYearQueries.selectYearById, [req.params.id]);
    if (existing.rows.length === 0 || existing.rows[0].school !== req.user.school) {
      return res.status(404).json({ status: 'failed', message: 'School year not found' });
    }
    const terms = await client.query(schoolYearQueries.countTermsForYear, [req.params.id]);
    if (terms.rows[0].count === 0) {
      return res.status(409).json({ status: 'failed', message: 'Add at least one term to this year before activating it' });
    }
    await client.query('BEGIN');
    await client.query(schoolYearQueries.deactivateAllYearsForSchool, [req.user.school]);
    const { rows } = await client.query(schoolYearQueries.setYearActive, [req.params.id]);
    // A year without a current term is unusable (nothing for report cards,
    // attendance, etc. to hang off of) — bring its earliest term along.
    await client.query(termQueries.deactivateAllTermsForSchool, [req.user.school]);
    const termResult = await client.query(termQueries.activateEarliestTermForYear, [req.params.id]);
    await client.query('COMMIT');
    const activatedTerm = termResult.rows[0]
      ? { termId: termResult.rows[0].term_id, name: termResult.rows[0].name }
      : null;
    return res.status(200).json({ status: 'success', data: { ...mapYear(rows[0]), activatedTerm } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    client.release();
  }
};

const deleteSchoolYear = async (req, res, next) => {
  try {
    const existing = await db.query(schoolYearQueries.selectYearById, [req.params.id]);
    if (existing.rows.length === 0 || existing.rows[0].school !== req.user.school) {
      return res.status(404).json({ status: 'failed', message: 'School year not found' });
    }
    if (existing.rows[0].is_active) {
      return res.status(409).json({ status: 'failed', message: 'Cannot delete the active school year' });
    }
    await db.query(schoolYearQueries.deleteYear, [req.params.id]);
    return res.status(200).json({ status: 'success', message: 'School year deleted' });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(409).json({ status: 'failed', message: 'This year still has data attached (students, classes or terms) — remove them first' });
    }
    next(error);
  }
};

module.exports = {
  getSchoolYears,
  createSchoolYear,
  updateSchoolYear,
  activateSchoolYear,
  deleteSchoolYear,
};
