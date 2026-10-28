// services/observe/alerts/notifier.js
//
// Turns a due notification (engine.dueNotifications) into an email to the
// platform owners and, for the moments that matter, a push to their phones.
// Sends straight through Resend like services/finance/alerts.js: never via
// email_outbox, which needs the database and the message notifier's tick.
//
// Every email about one incident shares its subject and References header, so
// the inbox keeps the whole story in one thread. A hard cap (6 an hour by
// default) protects the inbox if a rule misbehaves; a capped email waits for
// the next tick rather than being dropped.
const logger = require('../../../logger');
const { getResend, sendOrThrow } = require('../../../utils/emailUtils');
const { platformSender } = require('../../email/senderIdentity');
const { ownerEmails } = require('../../../middleware/requirePlatformOwner');
const {
  SCHOOLMULE_BRAND, renderEmail, paragraph, finePrint, note, facts, buttonRow, escapeHtml,
} = require('../../../templates/emailLayout');
const store = require('./store');
const ownerPush = require('./ownerPush');
const { TIME_ZONE } = require('./engine');
const { withTimeout } = require('./withTimeout');

const TIER_LABEL = { critical: 'Critical', warning: 'Warning', info: 'Notice' };
// Pushed: the moments worth a buzz. Reminders and summaries are email only.
const PUSHED = new Set(['opened', 'escalated', 'reopened', 'recovered', 'test']);
const MAX_BACKOFF_MS = 10 * 60 * 1000;
// Resend's SDK has no timeout of its own; a hung send must not freeze the tick.
const SEND_TIMEOUT_MS = 15 * 1000;

const maxPerHour = () => Number(process.env.ALERT_MAX_EMAILS_PER_HOUR) || 6;
const appUrl = () => (process.env.FRONTEND_URL || 'https://schoolmule.ca').replace(/\/+$/, '');

/** ALERT_EMAILS when set, otherwise the platform owners. */
function recipients() {
  const override = String(process.env.ALERT_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return override.length ? override : ownerEmails();
}

const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const clockFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });
const fmtTime = (t) => timeFmt.format(new Date(t));
const fmtClock = (t) => clockFmt.format(new Date(t));

function fmtDuration(msTotal) {
  const mins = Math.floor(msTotal / 60000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// The app and the web open the same path (pushes carry it as is).
const appPath = (inc) => `/observe/alerts?incident=${encodeURIComponent(inc.id)}`;
const incidentUrl = (inc) => `${appUrl()}${appPath(inc)}`;

function railwayUrl() {
  const { RAILWAY_PROJECT_ID: p, RAILWAY_SERVICE_ID: s, RAILWAY_ENVIRONMENT_ID: e } = process.env;
  if (!p || !s) return null;
  return `https://railway.com/project/${p}/service/${s}${e ? `?environmentId=${e}` : ''}`;
}

const subjectFor = (inc) => `[SchoolMule] ${TIER_LABEL[inc.tier]}: ${inc.title}`;
const threadId = (inc) => `<alert-${inc.id}@schoolmule.ca>`;

const ruleList = (inc) =>
  Object.values(inc.rules)
    .sort((a, b) => a.firstAt - b.firstAt)
    .map((r) => [r.name, `${escapeHtml(r.summary)}${r.lastAt ? ` <span style="color:#64748b;">(last ${escapeHtml(fmtClock(r.lastAt))})</span>` : ''}`]);

function totals(inc) {
  const s = inc.stats || {};
  return facts([
    ['Failed responses', s.failedRequests ? String(s.failedRequests) : '0'],
    ['Logged errors', s.loggedErrors ? String(s.loggedErrors) : '0'],
    ['People affected', String((s.people || []).length)],
    ['Worst 5 minutes', s.peakErrors5m ? `${s.peakErrors5m} errors` : null],
  ]);
}

function topErrors(inc) {
  const list = (inc.stats && inc.stats.topErrors) || [];
  if (!list.length) return '';
  const rows = list
    .slice(0, 5)
    .map((e) => `${escapeHtml(String(e.message).slice(0, 160))} <span style="color:#64748b;">&times;${e.count}</span>`)
    .join('<br>');
  return note('Top errors', rows);
}

function buttons(inc) {
  const list = [{ label: 'Open in Observe', url: inc ? incidentUrl(inc) : `${appUrl()}/observe/alerts` }];
  const railway = railwayUrl();
  if (railway) list.push({ label: 'Railway', url: railway });
  return buttonRow(list);
}

function footerFor(inc) {
  if (inc.tier === 'info') return 'A notice: no reminders follow. Tune or mute it in Observe → Alerts.';
  const pause = inc.tier === 'warning' ? ' (reminders pause 10 pm–7 am)' : '';
  return `You'll get one reminder an hour while this is open${pause}, and an email when it recovers. Tune or mute rules in Observe → Alerts.`;
}

/** { subject, html, push } for one incident email. */
function buildIncidentEmail(kind, inc, now) {
  const subject = inc.subject || subjectFor(inc);
  const latestSummary = Object.values(inc.rules).sort((a, b) => b.lastAt - a.lastAt)[0]?.summary || '';
  const open = fmtDuration(now - inc.openedAt);
  const head = {
    opened: inc.title,
    escalated: `Now critical: ${inc.title}`,
    reopened: `Back again: ${inc.title}`,
    reminder: `Still happening: ${inc.title}`,
    recovered: `Recovered after ${fmtDuration((inc.resolvedAt || now) - inc.openedAt)}`,
  }[kind];

  let intro;
  if (kind === 'recovered') {
    intro = paragraph(`${escapeHtml(inc.title)} started ${escapeHtml(fmtTime(inc.openedAt))}. Nothing has tripped since ${escapeHtml(fmtClock(inc.lastTripAt))}, and the database check and the server's own health check have passed for 15 minutes.`);
  } else if (kind === 'reopened') {
    intro = paragraph(`It had recovered, then tripped again at ${escapeHtml(fmtClock(inc.lastTripAt))}. First started ${escapeHtml(fmtTime(inc.openedAt))}.`);
  } else {
    intro = paragraph(`Started ${escapeHtml(fmtTime(inc.openedAt))}${kind === 'opened' ? '' : `, open for ${escapeHtml(open)}`}.`);
  }

  const html = renderEmail({
    brand: SCHOOLMULE_BRAND,
    heading: head,
    preheader: latestSummary,
    content: [
      intro,
      facts(ruleList(inc)),
      totals(inc),
      topErrors(inc),
      buttons(inc),
    ].join(''),
    footer: kind === 'recovered' ? '' : escapeHtml(footerFor(inc)),
  });

  const push = {
    opened: { title: `${TIER_LABEL[inc.tier]}: ${inc.title}`, body: latestSummary },
    escalated: { title: `Critical: ${inc.title}`, body: latestSummary },
    reopened: { title: `Back: ${inc.title}`, body: latestSummary },
    recovered: { title: `Recovered: ${inc.title}`, body: `After ${fmtDuration((inc.resolvedAt || now) - inc.openedAt)}.` },
  }[kind];

  return { subject: kind === 'opened' ? subject : `Re: ${subject}`, threadSubject: subject, html, push };
}

function buildSummaryEmail(incidents) {
  const n = incidents.length;
  const rows = incidents
    .sort((a, b) => a.openedAt - b.openedAt)
    .map((inc) => {
      const span = inc.resolvedAt ? `${fmtTime(inc.openedAt)} – ${fmtClock(inc.resolvedAt)} (${fmtDuration(inc.resolvedAt - inc.openedAt)})` : fmtTime(inc.openedAt);
      const what = Object.values(inc.rules).map((r) => r.summary).join(' ');
      return [`${TIER_LABEL[inc.tier]}: ${inc.title}`, `${escapeHtml(span)}<br><span style="color:#64748b;">${escapeHtml(what)}</span>`];
    });
  return {
    subject: `[SchoolMule] Overnight: ${n} ${n === 1 ? 'alert' : 'alerts'}, all resolved`,
    html: renderEmail({
      brand: SCHOOLMULE_BRAND,
      heading: 'Overnight alerts',
      preheader: `${n} held overnight and resolved before morning.`,
      content: [
        paragraph(`${n === 1 ? 'This alert was' : `These ${n} alerts were`} held between 10 pm and 7 am and resolved before morning.`),
        facts(rows),
        buttons(null),
      ].join(''),
    }),
  };
}

function buildTestEmail(now) {
  return {
    subject: '[SchoolMule] Test alert',
    html: renderEmail({
      brand: SCHOOLMULE_BRAND,
      heading: 'Test alert',
      preheader: 'Alert emails reach this inbox.',
      content: [
        paragraph(`Sent from Observe → Alerts at ${escapeHtml(fmtTime(now))}. Real alerts arrive from this address, so keep it out of spam.`),
        finePrint('Critical alerts go out at any hour. Warnings wait between 10 pm and 7 am Toronto time.'),
        buttons(null),
      ].join(''),
    }),
  };
}

// Failed sends back off (30 s, 1 min, 2 min … up to 10 min) instead of
// retrying every tick.
const backoff = new Map(); // key -> { until, failures }
const pushed = new Set();  // pushes already sent, so an email retry doesn't buzz twice
let lastCapLogAt = 0;

const deliveryKey = (item) => (item.kind === 'summary' ? 'summary' : `${item.kind}:${item.incident.id}:${item.incident.reopenCount}`);

async function sendEmail({ subject, html, threadOf }) {
  const to = recipients();
  if (!to.length) throw new Error('No alert recipients: set PLATFORM_OWNER_EMAILS or ALERT_EMAILS');
  const headers = threadOf ? { 'In-Reply-To': threadId(threadOf), References: threadId(threadOf) } : undefined;
  await withTimeout(sendOrThrow(getResend(), { ...platformSender('alerts'), to, subject, html, ...(headers ? { headers } : {}) }), SEND_TIMEOUT_MS, 'Sending the alert email');
  return to.length;
}

async function pushOnce(key, kind, inc, push, now) {
  if (!push || pushed.has(key)) return;
  pushed.add(key);
  const result = await ownerPush.send({ ...push, path: inc ? appPath(inc) : '/observe/alerts', kind: `alert_${kind}` });
  if (result.devices) {
    await store.logNotification({ incidentId: inc ? inc.id : null, channel: 'push', kind, ok: result.sent > 0, recipients: result.sent, subject: push.title, error: result.error, now });
  }
}

/**
 * Sends one due notification. Returns what happened, for the worker's log:
 * 'sent' | 'capped' | 'claimed-elsewhere' | 'backoff' | 'failed'.
 */
async function deliver(item, now = Date.now()) {
  const key = deliveryKey(item);
  const wait = backoff.get(key);
  if (wait && now < wait.until) return 'backoff';

  if ((await store.emailsLastHour(now)) >= maxPerHour()) {
    if (now - lastCapLogAt > 15 * 60 * 1000) {
      lastCapLogAt = now;
      logger.warn({ observe: true, kind: item.kind, cap: maxPerHour() }, 'Alerts: hourly email cap reached; holding emails');
    }
    return 'capped';
  }

  if (item.kind === 'summary') {
    const claimed = await store.claimSummary(item.incidents, now);
    if (!claimed.incidents.length) return 'claimed-elsewhere';
    const email = buildSummaryEmail(claimed.incidents);
    let n;
    try {
      n = await sendEmail(email);
    } catch (err) {
      await claimed.release();
      return fail(key, item, email.subject, null, err, now);
    }
    backoff.delete(key);
    await store.logNotification({ channel: 'email', kind: 'summary', ok: true, recipients: n, subject: email.subject, now });
    return 'sent';
  }

  const inc = item.incident;
  const email = buildIncidentEmail(item.kind, inc, now);
  const claim = await store.claim(item.kind, inc, now, email.threadSubject);
  if (!claim) return 'claimed-elsewhere';
  // The thread's subject is whatever the first email used.
  const subject = item.kind === 'opened' ? claim.subject : `Re: ${claim.subject}`;
  // Only the send is inside the try: anything after a sent email must not
  // hand the claim back, or the email would go out twice.
  let n;
  try {
    n = await sendEmail({ subject, html: email.html, threadOf: inc });
  } catch (err) {
    await claim.release();
    // Email down is exactly when the phone matters: push anyway (once).
    if (PUSHED.has(item.kind)) await pushOnce(key, item.kind, inc, email.push, now);
    return fail(key, item, subject, inc, err, now);
  }
  backoff.delete(key);
  await store.logNotification({ incidentId: inc.id, channel: 'email', kind: item.kind, ok: true, recipients: n, subject, now });
  if (PUSHED.has(item.kind)) await pushOnce(key, item.kind, inc, email.push, now);
  return 'sent';
}

async function fail(key, item, subject, inc, err, now) {
  const failures = (backoff.get(key)?.failures || 0) + 1;
  backoff.set(key, { failures, until: now + Math.min(MAX_BACKOFF_MS, 30000 * 2 ** (failures - 1)) });
  logger.warn({ observe: true, kind: item.kind, failures, err: err.message }, 'Alerts: email failed; will retry');
  await store.logNotification({ incidentId: inc ? inc.id : null, channel: 'email', kind: item.kind, ok: false, subject, error: err.message, now });
  return 'failed';
}

/** Observe → Alerts "Send test". Not capped; throws when the email fails. */
async function sendTest(channel = 'both', now = Date.now()) {
  const out = { email: null, push: null };
  if (channel === 'email' || channel === 'both') {
    const email = buildTestEmail(now);
    try {
      const n = await sendEmail(email);
      out.email = { ok: true, recipients: n };
      await store.logNotification({ channel: 'email', kind: 'test', ok: true, recipients: n, subject: email.subject, now }, { force: true });
    } catch (err) {
      out.email = { ok: false, error: err.message };
      await store.logNotification({ channel: 'email', kind: 'test', ok: false, subject: email.subject, error: err.message, now }, { force: true });
    }
  }
  if (channel === 'push' || channel === 'both') {
    await ownerPush.refresh(now, { force: true });
    const result = await ownerPush.send({ title: 'Test alert', body: 'Alert pushes reach this phone.', path: '/observe/alerts', kind: 'alert_test' });
    out.push = { ok: result.sent > 0, sent: result.sent, devices: result.devices, error: result.error || (result.devices ? undefined : 'No phone with the SchoolMule app is signed in to an owner account') };
    if (result.devices) {
      await store.logNotification({ channel: 'push', kind: 'test', ok: result.sent > 0, recipients: result.sent, subject: 'Test alert', error: result.error, now }, { force: true });
    }
  }
  return out;
}

function reset() {
  backoff.clear();
  pushed.clear();
  lastCapLogAt = 0;
}

module.exports = { deliver, sendTest, recipients, maxPerHour, buildIncidentEmail, fmtDuration, reset };
