/*
  controllers/gradebookStructure.controller.js
  Regrouping gradebook columns (Grades → Assessments & categories) for the
  class's teachers and admins; the routes run requireClassOwnership. Both
  answer with the class's whole assessment list, since a move changes the
  points of up to three rows and may remove an empty category. The flows
  live in services/classroom/assessmentStructure.js.
*/

const logger = require('../logger');
const engine = require('../services/analyticsEngine');
const structure = require('../services/classroom/assessmentStructure');
const { inTransaction } = require('../utils/transaction');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });

function fail(res, error, userMessage, context) {
  if (error && error.expose && error.status) return failed(res, error.status, error.message);
  logger.error({ err: error, ...context }, userMessage);
  return failed(res, 500, userMessage);
}

// POST /api/classroom/classes/:classId/assessments/:assessmentId/move  { categoryId: uuid | null }
const moveAssessment = async (req, res) => {
  const { classId, school } = req.class;
  const { assessmentId } = req.params;
  const categoryId = req.body?.categoryId ?? null;
  if (!UUID_RE.test(assessmentId)) return failed(res, 404, structure.NOT_FOUND_MESSAGE);
  if (categoryId !== null && (typeof categoryId !== 'string' || !UUID_RE.test(categoryId))) {
    return failed(res, 400, 'categoryId must be a category id or null');
  }
  try {
    const assessments = await inTransaction(async (client) => {
      const { changed } = await structure.moveAssessment(client, { classId, assessmentId, categoryId });
      if (changed) engine.invalidateCache(school);
      return structure.listClassAssessments(client, classId);
    });
    return res.status(200).json({ status: 'success', data: { assessments } });
  } catch (error) {
    return fail(res, error, "The assessment couldn't be moved", { classId, assessmentId });
  }
};

// POST /api/classroom/classes/:classId/assessments/:assessmentId/make-category
const makeCategory = async (req, res) => {
  const { classId, school } = req.class;
  const { assessmentId } = req.params;
  if (!UUID_RE.test(assessmentId)) return failed(res, 404, structure.NOT_FOUND_MESSAGE);
  try {
    const data = await inTransaction(async (client) => {
      const { categoryId } = await structure.makeCategory(client, { classId, assessmentId });
      return { categoryId, assessments: await structure.listClassAssessments(client, classId) };
    });
    engine.invalidateCache(school);
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    return fail(res, error, "The assessment couldn't become a multiple assessment", { classId, assessmentId });
  }
};

module.exports = { moveAssessment, makeCategory };
