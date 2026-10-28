const mockSend = jest.fn();
jest.mock('../../../../../utils/emailUtils', () => ({
  ...jest.requireActual('../../../../../utils/emailUtils'),
  getResend: () => ({ emails: { send: mockSend } }),
}));
jest.mock('../../../../../services/push/expoClient', () => ({ sendBatch: jest.fn() }));

const db = require('../../../../../__tests__/__mocks__/config/database');
const { sendBatch } = require('../../../../../services/push/expoClient');
const store = require('../../../../../services/observe/alerts/store');
const notifier = require('../../../../../services/observe/alerts/notifier');
const ownerPush = require('../../../../../services/observe/alerts/ownerPush');
const engine = require('../../../../../services/observe/alerts/engine');

const NOW = Date.parse('2026-10-22T02:02:00Z');

function incident(overrides = {}) {
  const inc = engine.newIncident('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NOW);
  return {
    ...inc,
    tier: 'critical',
    title: 'Database unreachable',
    rules: {
      db_unreachable: { name: 'Database unreachable', tier: 'critical', firstAt: NOW, lastAt: NOW, peak: 2, summary: 'The database check failed 2 times in a row: password authentication failed for user "postgres"' },
    },
    stats: { ...inc.stats, failedRequests: 8, loggedErrors: 9, people: ['u1'], peakErrors5m: 9, topErrors: [{ fingerprint: 'fp', message: 'Access resolution failed: <b>boom</b>', count: 4 }] },
    ...overrides,
  };
}

beforeEach(() => {
  store.reset();
  notifier.reset();
  ownerPush.reset();
  mockSend.mockReset();
  sendBatch.mockReset();
  process.env.PLATFORM_OWNER_EMAILS = 'owner@example.com';
});
afterAll(() => {
  delete process.env.PLATFORM_OWNER_EMAILS;
});

describe('email content', () => {
  it('opens a thread with the numbers, escaped errors and a link to the incident', () => {
    const email = notifier.buildIncidentEmail('opened', incident(), NOW);
    expect(email.subject).toBe('[SchoolMule] Critical: Database unreachable');
    expect(email.html).toContain('password authentication failed');
    expect(email.html).toContain('&lt;b&gt;boom&lt;/b&gt;');
    expect(email.html).not.toContain('<b>boom</b>');
    expect(email.html).toContain('/observe/alerts?incident=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(email.html).toContain('Wed, Oct 21, 10:02 PM');
    expect(email.push.title).toBe('Critical: Database unreachable');
  });

  it('follow-ups reply in the thread', () => {
    const inc = incident({ subject: '[SchoolMule] Critical: Database unreachable', resolvedAt: NOW + 700 * 60 * 1000 });
    const email = notifier.buildIncidentEmail('recovered', inc, NOW + 700 * 60 * 1000);
    expect(email.subject).toBe('Re: [SchoolMule] Critical: Database unreachable');
    expect(email.html).toContain('Recovered after 11 h 40 min');
  });

  it.each([[30 * 1000, 'under a minute'], [47 * 60 * 1000, '47 min'], [2 * 3600 * 1000, '2 h']])('fmtDuration(%i)', (ms, text) => {
    expect(notifier.fmtDuration(ms)).toBe(text);
  });

  it('ALERT_EMAILS overrides the owners', () => {
    process.env.ALERT_EMAILS = 'pager@example.com, me@example.com';
    try {
      expect(notifier.recipients()).toEqual(['pager@example.com', 'me@example.com']);
    } finally {
      delete process.env.ALERT_EMAILS;
    }
  });
});

describe('the database is down', () => {
  it('still claims, sends and remembers; writes it back when the database returns', async () => {
    mockSend.mockResolvedValue({ data: { id: 'e1' } });
    store.setDbAvailable(false);
    const inc = incident();
    await store.save({ open: inc, resolved: null });
    const outcome = await notifier.deliver({ kind: 'opened', incident: inc }, NOW);
    expect(outcome).toBe('sent');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(store.current(NOW).open).toMatchObject({ notifiedAt: NOW, notifiedTier: 'critical', subject: '[SchoolMule] Critical: Database unreachable' });

    // Back: the incident and the queued log row are written, then it reloads.
    store.setDbAvailable(true);
    await store.sync();
    const sqls = db.query.mock.calls.map((c) => c[0]);
    expect(sqls[0]).toMatch(/INSERT INTO alert_incidents/);
    expect(db.query.mock.calls[0][1][9]).toEqual(new Date(NOW)); // notified_at carried over
    expect(sqls[1]).toMatch(/INSERT INTO alert_notifications/);
    expect(sqls[2]).toMatch(/FROM alert_incidents/);
  });

  it('a query that fails mid-tick falls back to memory instead of throwing', async () => {
    mockSend.mockResolvedValue({ data: { id: 'e1' } });
    store.setDbAvailable(true);
    db.query.mockRejectedValue(new Error('Connection terminated unexpectedly'));
    const inc = incident();
    await store.save({ open: inc, resolved: null });
    expect(await notifier.deliver({ kind: 'opened', incident: inc }, NOW)).toBe('sent');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('delivery', () => {
  it('pushes once even when the email fails, and backs off before retrying', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ token: 'ExponentPushToken[a]' }] });
    await ownerPush.refresh(NOW, { force: true });
    sendBatch.mockResolvedValue([{ status: 'ok', id: 't1' }]);
    mockSend.mockResolvedValue({ error: { name: 'application_error', message: 'Resend is down' } });
    const inc = incident();
    await store.save({ open: inc, resolved: null });

    expect(await notifier.deliver({ kind: 'opened', incident: inc }, NOW)).toBe('failed');
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch.mock.calls[0][0][0]).toMatchObject({
      to: 'ExponentPushToken[a]',
      title: 'Critical: Database unreachable',
      channelId: 'reminders',
      data: { path: '/observe/alerts?incident=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', category: 'alerts', kind: 'alert_opened' },
    });
    // Claim handed back, so the email is still owed.
    expect(store.current(NOW).open.notifiedAt).toBeNull();
    expect(await notifier.deliver({ kind: 'opened', incident: inc }, NOW + 10 * 1000)).toBe('backoff');

    mockSend.mockResolvedValue({ data: { id: 'e2' } });
    expect(await notifier.deliver({ kind: 'opened', incident: inc }, NOW + 31 * 1000)).toBe('sent');
    expect(sendBatch).toHaveBeenCalledTimes(1);
  });

  it('holds emails over the hourly cap', async () => {
    mockSend.mockResolvedValue({ data: { id: 'e' } });
    for (let i = 0; i < 6; i += 1) await store.logNotification({ channel: 'email', kind: 'reminder', ok: true, now: NOW - i * 1000 });
    const inc = incident();
    await store.save({ open: inc, resolved: null });
    expect(await notifier.deliver({ kind: 'opened', incident: inc }, NOW)).toBe('capped');
    expect(mockSend).not.toHaveBeenCalled();
    expect(await notifier.deliver({ kind: 'opened', incident: inc }, NOW + 61 * 60 * 1000)).toBe('sent');
  });

  it('drops a phone Expo no longer knows', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ token: 'gone' }, { token: 'ok' }] });
    await ownerPush.refresh(NOW, { force: true });
    sendBatch.mockResolvedValue([{ status: 'error', details: { error: 'DeviceNotRegistered' } }, { status: 'ok', id: 't' }]);
    expect(await ownerPush.send({ title: 't', body: 'b', path: '/observe/alerts', kind: 'alert_test' })).toEqual({ sent: 1, devices: 2 });
    expect(ownerPush.tokenCount()).toBe(1);
    expect(db.query).toHaveBeenLastCalledWith(expect.stringMatching(/DELETE FROM push_devices/), [['gone']]);
  });
});
