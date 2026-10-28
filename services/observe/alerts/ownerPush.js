// services/observe/alerts/ownerPush.js
//
// Pushes alerts to the platform owners' phones. The app's own push queue
// (services/push/pushQueue.js) lives in Postgres, so it would stay silent
// during a database outage; alerts go straight to Expo instead, with the
// owners' device tokens kept in memory and refreshed while the database is up.
// Push preferences don't apply: muting a rule in Observe is how to quiet it.
const db = require('../../../config/database');
const logger = require('../../../logger');
const { sendBatch } = require('../../push/expoClient');
const { ownerEmails } = require('../../../middleware/requirePlatformOwner');

const REFRESH_MS = 10 * 60 * 1000;
// Android shows a push only on a channel the app has created. 'reminders' is
// high priority in every build; switch to 'alerts' once an Android build with
// that channel is out (ALERT_PUSH_CHANNEL=alerts).
const channelId = () => process.env.ALERT_PUSH_CHANNEL || 'reminders';

const OWNER_TOKENS = `
  SELECT d.token FROM push_devices d
  JOIN users u ON u.user_id = d.user_id
  WHERE LOWER(u.email) = ANY($1::text[]) AND COALESCE(u.is_archived, FALSE) = FALSE`;
const FORGET_TOKENS = `DELETE FROM push_devices WHERE token = ANY($1::text[])`;

let tokens = [];
let refreshedAt = 0;

const disabled = () => process.env.ALERT_PUSH_DISABLED === 'true';

/** Reloads the owners' tokens at most every 10 minutes (sooner with force). */
async function refresh(now = Date.now(), { force = false } = {}) {
  if (disabled() || (!force && now - refreshedAt < REFRESH_MS)) return tokens;
  const emails = ownerEmails();
  if (!emails.length) {
    tokens = [];
    refreshedAt = now;
    return tokens;
  }
  try {
    const { rows } = await db.query(OWNER_TOKENS, [emails]);
    tokens = rows.map((r) => r.token);
    refreshedAt = now;
  } catch (err) {
    logger.warn({ observe: true, err: err.message }, 'Alerts: could not refresh owner push tokens; keeping the last ones');
  }
  return tokens;
}

/**
 * @param {{ title: string, body: string, path: string, kind: string }} msg
 * @returns {Promise<{ sent: number, devices: number, error?: string }>}
 */
async function send({ title, body, path, kind }) {
  if (disabled() || !tokens.length) return { sent: 0, devices: 0 };
  const messages = tokens.map((to) => ({
    to,
    title: title.slice(0, 80),
    body: body.slice(0, 160),
    sound: 'default',
    priority: 'high',
    ttl: 3600,
    channelId: channelId(),
    data: { path, category: 'alerts', kind },
  }));
  try {
    const tickets = await sendBatch(messages);
    const gone = tickets
      .map((t, i) => (t.status === 'error' && t.details && t.details.error === 'DeviceNotRegistered' ? messages[i].to : null))
      .filter(Boolean);
    if (gone.length) {
      tokens = tokens.filter((t) => !gone.includes(t));
      db.query(FORGET_TOKENS, [gone]).catch(() => {});
    }
    return { sent: tickets.filter((t) => t.status === 'ok').length, devices: messages.length };
  } catch (err) {
    return { sent: 0, devices: messages.length, error: err.message };
  }
}

function reset() {
  tokens = [];
  refreshedAt = 0;
}

module.exports = { refresh, send, reset, tokenCount: () => tokens.length };
