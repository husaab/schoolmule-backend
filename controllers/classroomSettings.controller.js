/*
  controllers/classroomSettings.controller.js
  GET/PUT /api/admin/classroom-settings: the school's student-portal switches
  (logins from which grade, QR cards up to which grade, student email, the
  parents' weekly summary day...). Admin only; the school comes from the token.
*/

const logger = require('../logger');
const { getSettings, validateSettings, saveSettings } = require('../services/classroom/classroomSettings');

// GET /api/admin/classroom-settings
const getClassroomSettings = async (req, res) => {
  try {
    return res.status(200).json({ status: 'success', data: await getSettings(req.user.school) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load classroom settings');
    return res.status(500).json({ status: 'failed', message: 'Error loading classroom settings' });
  }
};

// PUT /api/admin/classroom-settings  (full ClassroomSettings minus updatedAt)
const OPTIONAL_KEYS = ['studentEmailDomains', 'studentSignIn'];

const putClassroomSettings = async (req, res) => {
  // A bad body is refused before anything is read.
  const checked = validateSettings(req.body);
  if (checked.error) return res.status(400).json({ status: 'failed', message: checked.error });

  try {
    // The invitation settings an older client leaves out keep their saved values.
    const leftOut = OPTIONAL_KEYS.some((key) => req.body[key] === undefined);
    const { value } = leftOut ? validateSettings(req.body, await getSettings(req.user.school)) : checked;

    const saved = await saveSettings(req.user.school, value, req.user.userId);
    return res.status(200).json({ status: 'success', data: saved });
  } catch (err) {
    logger.error({ err }, 'Failed to save classroom settings');
    return res.status(500).json({ status: 'failed', message: 'Error saving classroom settings' });
  }
};

module.exports = { getClassroomSettings, putClassroomSettings };
