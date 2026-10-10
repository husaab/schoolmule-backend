// services/finance/alerts.js
//
// Tells a human when the QuickBooks sync is stuck. The sync engine decides
// *whether* a failure is alert-worthy (three in a row, or a dead grant); this
// module decides *how often* (once per 24 h) and sends the email.
//
// Alert failures never fail a sync run: they are logged and swallowed.

const db = require('../../config/database');
const logger = require('../../logger');
const queries = require('../../queries/finance.queries');
const { getResend, sendOrThrow } = require('../../utils/emailUtils');
const { platformSender } = require('../email/senderIdentity');
const { SCHOOLMULE_BRAND, renderEmail, paragraph, note, button } = require('../../templates/emailLayout');

const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function recipients(school) {
  if (process.env.FINANCE_ALERT_EMAIL) return [process.env.FINANCE_ALERT_EMAIL];
  const { rows } = await db.query(queries.selectAdminEmails, [school]);
  return rows.map((r) => r.email).filter(Boolean);
}

/**
 * @param {object} p
 * @param {string}  p.school
 * @param {number}  p.consecutiveFailures
 * @param {boolean} p.needsReconnect
 * @param {string}  p.error
 * @param {string|Date|null} p.alertedAt   last time we alerted, from the connection row
 * @param {Array}   [p.recentErrors]
 * @returns {Promise<boolean>} whether an email was sent
 */
async function notifySyncFailure({ school, consecutiveFailures, needsReconnect, error, alertedAt, recentErrors = [] }) {
  try {
    if (alertedAt && Date.now() - new Date(alertedAt).getTime() < ALERT_COOLDOWN_MS) return false;

    const to = await recipients(school);
    if (to.length === 0) {
      logger.warn({ school }, 'QuickBooks sync alert: no recipient configured');
      return false;
    }

    const subject = needsReconnect
      ? `[SchoolMule] QuickBooks needs to be reconnected (${school})`
      : `[SchoolMule] QuickBooks sync failing for ${school}`;
    const appUrl = process.env.FRONTEND_URL || '';
    const errors = [error, ...recentErrors].filter(Boolean).slice(0, 3);
    const html = renderEmail({
      brand: SCHOOLMULE_BRAND,
      heading: needsReconnect ? 'Reconnect QuickBooks' : 'QuickBooks sync is failing',
      preheader: needsReconnect
        ? 'QuickBooks rejected the stored authorization.'
        : `The sync has failed ${consecutiveFailures} times in a row.`,
      content: [
        paragraph(needsReconnect
          ? 'QuickBooks rejected the stored authorization. An admin needs to open Finance → Tuition and click <b>Connect QuickBooks</b> again.'
          : `The QuickBooks sync has failed ${consecutiveFailures} times in a row. The Tuition page is showing stale data until it recovers.`),
        errors.length ? note('Recent errors', errors.map(esc).join('<br>')) : '',
        button('Open Finance → Tuition', `${appUrl}/finance/tuition`),
      ].join(''),
    });

    // sendOrThrow: a rejected email must not start the 24h cooldown below.
    await sendOrThrow(getResend(), { ...platformSender('notification'), to, subject, html });
    await db.query(queries.markAlerted, [school]);
    logger.warn({ school, to: to.length, needsReconnect, consecutiveFailures }, 'QuickBooks sync alert sent');
    return true;
  } catch (err) {
    logger.error({ school, err }, 'QuickBooks sync alert could not be sent');
    return false;
  }
}

module.exports = { notifySyncFailure, ALERT_COOLDOWN_MS };
