// services/aiUsage.js
//
// How much of the shared OpenAI key each person and each school has used, and
// the two limits that keep one account from spending it without end:
//
//   a person:  AI_USER_DAILY_REQUESTS   requests a day (default 400)
//   a school:  AI_SCHOOL_MONTHLY_TOKENS tokens a month (default 40,000,000)
//
// A day and a month are the school day and month in America/Toronto, the
// same clock the weekly summary uses. The defaults are far above ordinary use
// (a teacher drafting a comment for every student in every class stays well
// under the daily one): they stop abuse and runaway loops, they are not a
// budget. Zero or a negative number switches a limit off.
//
// Everything here fails open. Usage is counted in ai_usage_daily; if that
// table can't be read or written (an older database, an outage) the AI
// feature still runs and the failure is logged.

const db = require('../config/database');
const logger = require('../logger');

const TIMEZONE = 'America/Toronto';
const TODAY = `(NOW() AT TIME ZONE '${TIMEZONE}')::date`;

// The AI features that are counted. A name outside this list is refused, so
// the table can't be filled with made-up features.
const FEATURES = Object.freeze([
  'generate_comment',
  'generate_jksk_comment',
  'generate_progress_comment',
  'dashboard_briefing',
  'analytics_chat',
  'analytics_insights',
  'analytics_report',
  'analytics_at_risk',
  'weekly_summary',
  'assistant',
  'assistant_voice',
]);
const isFeature = (feature) => FEATURES.includes(feature);

const USER_DAILY = 'AI_LIMIT_USER_DAILY';
const SCHOOL_MONTHLY = 'AI_LIMIT_SCHOOL_MONTHLY';
const MESSAGES = {
  [USER_DAILY]: "You've reached today's limit for AI features. It resets tomorrow.",
  [SCHOOL_MONTHLY]: "Your school has reached this month's limit for AI features. It resets next month.",
};

const numberFrom = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
};
const limits = () => ({
  userDailyRequests: numberFrom(process.env.AI_USER_DAILY_REQUESTS, 400),
  schoolMonthlyTokens: numberFrom(process.env.AI_SCHOOL_MONTHLY_TOKENS, 40_000_000),
});

const selectUserToday = `
  SELECT COALESCE(SUM(requests), 0)::int AS requests
  FROM ai_usage_daily
  WHERE user_id = $1 AND day = ${TODAY}
`;
const selectSchoolMonth = `
  SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens
  FROM ai_usage_daily
  WHERE school = $1
    AND day >= date_trunc('month', ${TODAY})::date
`;
const upsertUsage = `
  INSERT INTO ai_usage_daily (user_id, day, feature, school, requests, input_tokens, cached_input_tokens, output_tokens)
  VALUES ($1, ${TODAY}, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (user_id, day, feature) DO UPDATE SET
    requests            = ai_usage_daily.requests + EXCLUDED.requests,
    input_tokens        = ai_usage_daily.input_tokens + EXCLUDED.input_tokens,
    cached_input_tokens = ai_usage_daily.cached_input_tokens + EXCLUDED.cached_input_tokens,
    output_tokens       = ai_usage_daily.output_tokens + EXCLUDED.output_tokens
`;

const refusal = (code) => ({ ok: false, code, message: MESSAGES[code] });
const OK = Object.freeze({ ok: true });

/** A whole number of tokens between 0 and 5,000,000, whatever was sent. */
const tokens = (value) => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5_000_000) : 0;
};

/** Whether the school is still under its monthly token limit. */
async function checkSchool(school) {
  const { schoolMonthlyTokens } = limits();
  if (!(schoolMonthlyTokens > 0) || !school) return OK;
  try {
    const { rows } = await db.query(selectSchoolMonth, [school]);
    return Number(rows[0]?.tokens || 0) >= schoolMonthlyTokens ? refusal(SCHOOL_MONTHLY) : OK;
  } catch (err) {
    logger.warn({ err }, 'AI usage could not be read; the school limit was not checked');
    return OK;
  }
}

/** Whether this person, and their school, may make another AI request now. */
async function check({ school, userId }) {
  const { userDailyRequests } = limits();
  if (userDailyRequests > 0 && userId) {
    try {
      const { rows } = await db.query(selectUserToday, [userId]);
      if (Number(rows[0]?.requests || 0) >= userDailyRequests) return refusal(USER_DAILY);
    } catch (err) {
      logger.warn({ err }, 'AI usage could not be read; the daily limit was not checked');
    }
  }
  return checkSchool(school);
}

/** Add to today's count for this person and feature. Never throws. */
async function record({ school, userId, feature, requests = 0, inputTokens = 0, cachedInputTokens = 0, outputTokens = 0 }) {
  if (!school || !userId || !isFeature(feature)) return false;
  try {
    await db.query(upsertUsage, [
      userId, feature, school,
      Math.max(0, Math.floor(Number(requests)) || 0),
      tokens(inputTokens), tokens(cachedInputTokens), tokens(outputTokens),
    ]);
    return true;
  } catch (err) {
    logger.warn({ err, feature }, 'AI usage could not be recorded');
    return false;
  }
}

/**
 * The start of one AI request: refuse it when a limit is reached, otherwise
 * count it. -> { ok: true } | { ok: false, code, message }
 */
async function start({ school, userId, feature }) {
  const verdict = await check({ school, userId });
  if (!verdict.ok) return verdict;
  await record({ school, userId, feature, requests: 1 });
  return OK;
}

module.exports = { FEATURES, isFeature, limits, check, checkSchool, record, start, USER_DAILY, SCHOOL_MONTHLY };
