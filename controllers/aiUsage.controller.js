// controllers/aiUsage.controller.js
const aiUsage = require('../services/aiUsage');

const UNKNOWN_FEATURE = { status: 'failed', message: 'Unknown AI feature' };

/**
 * POST /api/ai-usage/start { feature }
 * 200 when the request may go ahead (and is now counted); 429 with a code
 * (AI_LIMIT_USER_DAILY | AI_LIMIT_SCHOOL_MONTHLY) and a message to show when
 * the person or the school has reached a limit.
 */
const startRequest = async (req, res) => {
  const { feature } = req.body || {};
  if (!aiUsage.isFeature(feature)) return res.status(400).json(UNKNOWN_FEATURE);

  const verdict = await aiUsage.start({ school: req.user.school, userId: req.user.userId, feature });
  if (!verdict.ok) {
    return res.status(429).json({ status: 'failed', code: verdict.code, message: verdict.message });
  }
  return res.status(200).json({ status: 'success' });
};

/**
 * POST /api/ai-usage/record { feature, inputTokens, cachedInputTokens, outputTokens }
 * Adds the tokens one finished request used. Always 200 for a known feature:
 * a record that can't be written is logged, not reported.
 */
const recordUsage = async (req, res) => {
  const { feature, inputTokens, cachedInputTokens, outputTokens } = req.body || {};
  if (!aiUsage.isFeature(feature)) return res.status(400).json(UNKNOWN_FEATURE);

  await aiUsage.record({
    school: req.user.school,
    userId: req.user.userId,
    feature,
    inputTokens,
    cachedInputTokens,
    outputTokens,
  });
  return res.status(200).json({ status: 'success' });
};

module.exports = { startRequest, recordUsage };
