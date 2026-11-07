// controllers/reportGeneration.controller.js
//
// Report cards and progress reports generated in the background
// (services/reportGeneration/runs.js). Starting a run only queues it and
// answers 202; the worker prints it. Every run is read in the caller's
// school, and a page lists the runs of its selected school year.

const logger = require('../logger');
const runs = require('../services/reportGeneration/runs');

const yearOf = (req) => req.schoolYear?.schoolYearId ?? null;

const fail = (res, error, message) => {
  if (error.expose && error.status) {
    return res.status(error.status).json({ status: 'error', message: error.message });
  }
  logger.error({ err: error }, message);
  return res.status(500).json({ status: 'error', message });
};

const NOT_FOUND = { status: 'error', message: 'Run not found' };

// POST /api/report-generation/runs { reportType, term, studentIds, reportDate? }
const startRun = async (req, res) => {
  try {
    const { reportType, term, studentIds, reportDate } = req.body || {};
    const queued = await runs.queueRun({
      school: req.user.school,
      schoolYearId: yearOf(req),
      userId: req.user?.userId ?? null,
      reportType,
      term,
      studentIds,
      reportDate,
    });
    return res.status(202).json({ status: 'success', data: queued });
  } catch (error) {
    return fail(res, error, "Couldn't start generating these reports");
  }
};

// GET /api/report-generation/runs?reportType=&term=
const listRuns = async (req, res) => {
  try {
    const { reportType, term } = req.query;
    const data = await runs.listRuns({ school: req.user.school, schoolYearId: yearOf(req), reportType, term });
    return res.json({ status: 'success', data });
  } catch (error) {
    return fail(res, error, "Couldn't load report generation");
  }
};

const control = (action, message) => async (req, res) => {
  try {
    const studentIds = action === 'retryRun' && req.body?.studentIds !== undefined ? req.body.studentIds : null;
    const run = await runs[action]({ runId: req.params.runId, school: req.user.school, studentIds });
    if (!run) return res.status(404).json(NOT_FOUND);
    return res.json({ status: 'success', data: run });
  } catch (error) {
    return fail(res, error, message);
  }
};

module.exports = {
  startRun,
  listRuns,
  cancelRun: control('cancelRun', "Couldn't stop this run"),
  retryRun: control('retryRun', "Couldn't try these again"),
  dismissRun: control('dismissRun', "Couldn't dismiss this run"),
};
