// middleware/requireAssistant.js
//
// Who Muley answers. In order:
//   1. the kill switch must not be thrown (ASSISTANT_ENABLED=false stops Muley everywhere);
//   2. never during an admin "view as" preview: the previewer must not read
//      or continue the other person's conversations (a preview token's POSTs
//      are already refused by verifyUser; this covers the GETs);
//   3. staff and parent views. Students are fenced off before any route
//      runs. A parent gets the family tool set, which reads only
//      /api/parent-portal (and the parent API gate enforces that every one of
//      their requests stays in the parent areas);
//   4. the school has Muley switched on, and on for this view.
//
// available(req) is the same decision as a value, for the endpoint that
// tells the app whether to show Muley at all.

const config = require('../services/assistant/config');
const settings = require('../services/assistant/settings');
const logger = require('../logger');

const refusal = (code, message) => ({ ok: false, code, message });

async function available(req) {
  if (!config.enabled()) return refusal('ASSISTANT_DISABLED', 'Muley is not available.');
  if (req.user && req.user.impersonator) return refusal('ASSISTANT_OFF_IN_PREVIEW', 'Muley is off during a preview. Exit the preview to use it.');
  if (!req.access || !(req.access.isStaffView || req.access.view === 'PARENT')) return refusal('ASSISTANT_NOT_AVAILABLE', 'Muley is not available for this account yet.');
  const school = await settings.get(req.user.school);
  if (!settings.onFor(school, req.access.view)) return refusal('ASSISTANT_DISABLED', "Muley isn't switched on for your school.");
  return { ok: true, settings: school };
}

const requireAssistant = async (req, res, next) => {
  try {
    const verdict = await available(req);
    if (!verdict.ok) {
      return res.status(403).json({ status: 'failed', code: verdict.code, message: verdict.message });
    }
    req.assistant = { settings: verdict.settings };
    return next();
  } catch (error) {
    logger.error({ err: error }, 'Assistant availability check failed');
    return res.status(503).json({ status: 'failed', code: 'ASSISTANT_UNAVAILABLE', message: "Muley can't be reached right now." });
  }
};

requireAssistant.available = available;
module.exports = requireAssistant;
