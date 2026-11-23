/*
  controllers/adminOverview.controller.js
  GET /api/admin/overview: the admin panel's live facts. One block per admin
  area (services/adminOverview/blocks.js), each only for a caller who may
  open that area; a block they may not open is left out. A block whose query
  fails is { error: true } on its own, the rest still answer. The school comes
  from the token, the year from X-School-Year (resolveSchoolYear).
*/

const db = require('../config/database');
const logger = require('../logger');
const { can, isFullAdmin } = require('../services/access/access');
const blocks = require('../services/adminOverview/blocks');
const { runBlocks, OverviewUnavailableError } = require('../services/adminOverview/runBlocks');
const { torontoDate } = require('../services/adminOverview/shape');

const holds = (key) => (req) => can(req, key);

// Who sees each block, in the order they run: cheap ones first, the report
// templates (they compare whole template docs) last.
const BLOCKS = [
  ['assets', holds('school_setup')],
  ['roles', isFullAdmin],
  ['patchNotes', isFullAdmin],
  ['calendar', holds('school_setup')],
  ['schoolSettings', holds('school_setup')],
  ['approvals', holds('users')],
  ['users', holds('users')],
  ['agendas', holds('scheduling')],
  ['planner', holds('scheduling')],
  ['finance', holds('finance')],
  ['reportRuns', holds('report_cards')],
  ['forms', holds('forms')],
  ['meetings', holds('scheduling')],
  ['relations', holds('users')],
  ['studentAccounts', holds('users')],
  ['messages', holds('messages.all')],
  ['reportTemplates', holds('school_setup')],
];

const getOverview = async (req, res) => {
  const now = new Date();
  const year = req.schoolYear || null;
  const ctx = { school: req.user.school, yearId: year?.schoolYearId ?? null, today: torontoDate(now), now, req };
  // Looked up per request (not at load) so a test can stand in for one block.
  const tasks = BLOCKS.filter(([, allowed]) => allowed(req)).map(([key]) => ({ key, run: blocks[key] }));

  try {
    const results = await runBlocks(db, tasks, ctx, { logger });
    const data = {
      generatedAt: now.toISOString(),
      today: ctx.today,
      schoolYear: year ? { schoolYearId: year.schoolYearId, label: year.label, isActive: Boolean(year.isActive) } : null,
    };
    for (const { key } of tasks) data[key] = results[key];
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    if (error instanceof OverviewUnavailableError) {
      logger.warn({ err: error.cause }, 'Admin overview unavailable: no database client');
      return res.status(503).json({ status: 'failed', message: 'The overview is busy. Try again in a moment.' });
    }
    logger.error({ err: error }, 'Error loading the admin overview');
    return res.status(500).json({ status: 'failed', message: 'Error loading the admin overview' });
  }
};

module.exports = { getOverview, BLOCKS };
