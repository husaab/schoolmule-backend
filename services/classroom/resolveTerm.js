// services/classroom/resolveTerm.js
//
// The term a grades read uses. Moved verbatim from
// controllers/parentPortal.controller.js so the parent portal, the student
// portal and the parent's Classes lens resolve the term the same way.

const db = require('../../config/database');
const engine = require('../analyticsEngine');
const termQueries = require('../../queries/term.queries');

/**
 * Resolve the term to use: explicit ?termId= (accepts the 'all' sentinel),
 * otherwise a sensible default WITHIN the selected school year
 * (req.schoolYear, from the X-School-Year header): the active term if it
 * belongs to that year, else the term containing today, else the most
 * recently ended, else the first. Explicit termIds are checked against the
 * parent's school and the selected year so a probed or stale UUID resolves
 * to null instead of leaking another scope's data.
 * Returns { termId, row } where row is the full term row when available.
 */
async function resolveTerm(req) {
  const requested = req.query.termId;
  const yearId = req.schoolYear?.schoolYearId ?? null;

  if (requested === engine.ALL_TERMS) return { termId: engine.ALL_TERMS, row: null };
  if (requested) {
    const { rows } = await db.query(termQueries.selectTermById, [requested]);
    const row = rows[0];
    const wrongSchool = !row || row.school !== req.user.school;
    const wrongYear = row && yearId && row.school_year_id && row.school_year_id !== yearId;
    if (wrongSchool || wrongYear) return { termId: null, row: null };
    return { termId: row.term_id, row };
  }

  const { rows } = await db.query(termQueries.selectTermsBySchool, [req.user.school, yearId]);
  if (rows.length === 0) return { termId: null, row: null };

  const today = new Date().toISOString().slice(0, 10);
  const dateOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  const row =
    rows.find((t) => t.is_active) ||
    rows.find((t) => dateOf(t.start_date) <= today && today <= dateOf(t.end_date)) ||
    rows.filter((t) => dateOf(t.end_date) < today).pop() ||
    rows[0];
  return { termId: row.term_id, row };
}

module.exports = { resolveTerm };
