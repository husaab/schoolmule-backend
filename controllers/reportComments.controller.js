/*
  controllers/reportComments.controller.js
  /api/report-comments: the word limits and the review lock for report card
  and progress report comments (services/reportComments/rules.js).

  GET /class/:classId   what a class's comment pages show: the limits, whether
                        each document is locked, and whether the caller may
                        still edit while it is
  GET /overview         the review page (school_setup)
  PUT /limits           the school's limits (school_setup)
  PUT /locks/term       lock or reopen a whole term for a document (school_setup)
  PUT /locks/class      lock or reopen one class for a document (school_setup)
*/

const logger = require('../logger');
const rules = require('../services/reportComments/rules');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (res, message) => res.status(400).json({ status: 'failed', message });

// GET /api/report-comments/class/:classId
const getClassRules = async (req, res) => {
  const { classId } = req.params;
  try {
    const [cls] = await rules.classRules([classId]);
    if (!cls) return res.status(404).json({ status: 'failed', message: 'Not found' });
    const data = { canEditLocked: rules.canReview(req) };
    for (const kind of rules.KINDS) data[rules.KEY[kind]] = cls.rules[kind];
    return res.status(200).json({ status: 'success', data });
  } catch (err) {
    logger.error({ err }, 'Failed to load the comment rules of a class');
    return res.status(500).json({ status: 'failed', message: 'Error loading the comment rules' });
  }
};

// GET /api/report-comments/overview?termId=
const getOverview = async (req, res) => {
  const { termId } = req.query;
  if (termId !== undefined && !UUID_RE.test(String(termId))) return bad(res, 'Invalid termId');
  try {
    const schoolYearId = req.schoolYear && req.schoolYear.schoolYearId;
    const term = await rules.findTerm(req.user.school, schoolYearId, termId);
    if (termId && !term) return res.status(404).json({ status: 'failed', message: 'Term not found' });
    return res.status(200).json({ status: 'success', data: await rules.overview(req.user.school, term) });
  } catch (err) {
    logger.error({ err }, 'Failed to load the report comments overview');
    return res.status(500).json({ status: 'failed', message: 'Error loading report comments' });
  }
};

// PUT /api/report-comments/limits  { reportCard: { minWords, maxWords }, progressReport: { minWords, maxWords } }
const putLimits = async (req, res) => {
  const checked = rules.validateLimits(req.body);
  if (checked.error) return bad(res, checked.error);
  try {
    const saved = await rules.saveLimits(req.user.school, checked.value, req.user.userId);
    return res.status(200).json({ status: 'success', data: saved });
  } catch (err) {
    logger.error({ err }, 'Failed to save the comment limits');
    return res.status(500).json({ status: 'failed', message: 'Error saving the comment limits' });
  }
};

const readLock = (body) => {
  const { kind, locked } = body || {};
  if (!rules.isKind(kind)) return { error: 'kind must be report_card or progress_report' };
  if (typeof locked !== 'boolean') return { error: 'locked must be true or false' };
  return { kind, locked };
};

// PUT /api/report-comments/locks/term  { termId, kind, locked }
const putTermLock = async (req, res) => {
  const lock = readLock(req.body);
  if (lock.error) return bad(res, lock.error);
  const { termId } = req.body;
  if (!UUID_RE.test(String(termId))) return bad(res, 'Invalid termId');
  try {
    const term = await rules.findTerm(req.user.school, null, termId);
    if (!term) return res.status(404).json({ status: 'failed', message: 'Term not found' });
    await rules.setTermLock(termId, lock.kind, lock.locked, req.user.userId);
    return res.status(200).json({ status: 'success', data: await rules.overview(req.user.school, term) });
  } catch (err) {
    logger.error({ err }, 'Failed to lock or reopen a term');
    return res.status(500).json({ status: 'failed', message: 'Error changing the lock' });
  }
};

// PUT /api/report-comments/locks/class  { classId, kind, locked }
const putClassLock = async (req, res) => {
  const lock = readLock(req.body);
  if (lock.error) return bad(res, lock.error);
  const { classId } = req.body;
  if (!UUID_RE.test(String(classId))) return bad(res, 'Invalid classId');
  try {
    const result = await rules.setClassLock(req.user.school, classId, lock.kind, lock.locked, req.user.userId);
    if (result === 'not_found') return res.status(404).json({ status: 'failed', message: 'Class not found' });
    if (result === 'kindergarten') {
      return res.status(400).json({
        status: 'failed',
        code: 'KINDERGARTEN_FOLLOWS_TERM',
        message: 'JK and SK comments are locked and reopened with the whole term.',
      });
    }
    const [cls] = await rules.classRules([classId], [lock.kind]);
    return res.status(200).json({ status: 'success', data: { classId, kind: lock.kind, ...cls.rules[lock.kind] } });
  } catch (err) {
    logger.error({ err }, 'Failed to lock or reopen a class');
    return res.status(500).json({ status: 'failed', message: 'Error changing the lock' });
  }
};

module.exports = { getClassRules, getOverview, putLimits, putTermLock, putClassLock };
