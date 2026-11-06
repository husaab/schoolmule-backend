// controllers/modifiedMark.controller.js
//
// A teacher marks one student's score as modified: a real mark on a different
// version of an assessment. A category stands for each item in it. Nothing here
// emails a family; `published` tells the client to warn the teacher that the
// family will see the change without being told (utils/modifiedMark.js).
//
//   PUT    /api/studentAssessments/classes/:classId/modified-marks/:studentId/:assessmentId
//          { label?: string|null }
//   DELETE /api/studentAssessments/classes/:classId/modified-marks/:studentId/:assessmentId

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/modifiedMark.queries');
const { selectEnrolment } = require('../queries/classStatsExclusions.queries');
const engine = require('../services/analyticsEngine');
const { invalidateWeeklySummaries } = require('../services/aiWeeklySummary.service');
const { MODIFIED_LABEL_ERROR, normalizeModifiedLabel, validateModifiedLabel } = require('../utils/modifiedMark');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSESSMENT_NOT_FOUND = 'Assessment not found in this class';

const badIds = ({ studentId, assessmentId }) => !UUID_RE.test(studentId || '') || !UUID_RE.test(assessmentId || '');

/** A changed flag reaches everything that reads the cached matrix and the family's summary. */
async function afterChange(req, studentId, published) {
  engine.invalidateCache(req.user.school);
  if (published) await invalidateWeeklySummaries([studentId]);
}

const setModifiedMark = async (req, res) => {
  const { classId, studentId, assessmentId } = req.params;
  if (badIds(req.params)) {
    return res.status(400).json({ status: 'failed', message: 'studentId and assessmentId must be ids' });
  }

  const raw = req.body?.label;
  if (raw != null && typeof raw !== 'string') {
    return res.status(400).json({ status: 'failed', message: MODIFIED_LABEL_ERROR });
  }
  const label = normalizeModifiedLabel(raw);
  const labelError = validateModifiedLabel(label);
  if (labelError) return res.status(400).json({ status: 'failed', message: labelError });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const enrolled = await client.query(selectEnrolment, [classId, studentId]);
    if (enrolled.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'failed', message: "This student isn't in this class" });
    }

    const { rows: targets } = await client.query(q.selectTargets, [classId, assessmentId]);
    if (targets.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'failed', message: ASSESSMENT_NOT_FOUND });
    }

    const ids = targets.map((t) => t.assessment_id);
    const { rows } = await client.query(q.upsert, [studentId, ids, label, req.user?.userId ?? null]);
    await client.query('COMMIT');

    const published = targets.some((t) => t.is_published);
    await afterChange(req, studentId, published);
    return res.status(200).json({ status: 'success', data: rows, published });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(err);
    return res.status(500).json({ status: 'failed', message: "Couldn't save the modified mark" });
  } finally {
    client.release();
  }
};

const clearModifiedMark = async (req, res) => {
  const { classId, studentId, assessmentId } = req.params;
  if (badIds(req.params)) {
    return res.status(400).json({ status: 'failed', message: 'studentId and assessmentId must be ids' });
  }

  try {
    const { rows: targets } = await db.query(q.selectTargets, [classId, assessmentId]);
    if (targets.length === 0) {
      return res.status(404).json({ status: 'failed', message: ASSESSMENT_NOT_FOUND });
    }

    const { rowCount } = await db.query(q.remove, [studentId, targets.map((t) => t.assessment_id)]);
    const published = targets.some((t) => t.is_published);
    await afterChange(req, studentId, published);
    return res.status(200).json({ status: 'success', data: { removed: rowCount }, published });
  } catch (err) {
    logger.error(err);
    return res.status(500).json({ status: 'failed', message: "Couldn't remove the modified mark" });
  }
};

module.exports = { setModifiedMark, clearModifiedMark };
