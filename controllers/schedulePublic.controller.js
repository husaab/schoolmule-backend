// Public (unauthenticated) read-only access to a published schedule via its
// share token. Mounted BEFORE verifyUser in server.js.

const db = require('../config/database');
const q = require('../queries/schedulePlanner.queries');
const logger = require('../logger');
const { mapMaterializedSession } = require('./schedulePlanner.controller');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getPublicSchedule = async (req, res) => {
  const { schoolSlug, shareToken } = req.params;
  if (!UUID_RE.test(shareToken)) {
    return res.status(404).json({ status: 'failed', message: 'Schedule not found' });
  }
  try {
    const { rows } = await db.query(q.selectPublicSchedule, [schoolSlug, shareToken]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: 'Schedule not found' });
    }
    const schedule = rows[0];
    const { rows: sessionRows } = await db.query(q.selectSessionsForSchedule, [
      schedule.schedule_id,
    ]);
    return res.status(200).json({
      status: 'success',
      data: {
        schoolName: schedule.school_name,
        scheduleName: schedule.schedule_name,
        publishedAt: schedule.published_at,
        sessions: sessionRows.map(mapMaterializedSession),
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching public schedule');
    return res.status(500).json({ status: 'failed', message: 'Error fetching schedule' });
  }
};

module.exports = { getPublicSchedule };
