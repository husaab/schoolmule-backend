jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ id: 'e1' }) } })) }));

const db = require('../../../__mocks__/config/database');
const { mockQueryResponse } = require('../../../helpers/mockDb');
const { Resend } = require('resend');
const { notifySyncFailure, ALERT_COOLDOWN_MS } = require('../../../../services/finance/alerts');

const base = { school: 'ALHAADIACADEMY', consecutiveFailures: 3, needsReconnect: false, error: 'QuickBooks server error (503)', alertedAt: null };

describe('alerts.notifySyncFailure', () => {
  afterEach(() => { delete process.env.FINANCE_ALERT_EMAIL; });

  it('emails the school admins and records the alert time', async () => {
    mockQueryResponse([{ email: 'a@school.ca' }, { email: 'b@school.ca' }]);
    mockQueryResponse([]); // markAlerted
    await expect(notifySyncFailure(base)).resolves.toBe(true);
    const send = Resend.mock.results.at(-1).value.emails.send;
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: ['a@school.ca', 'b@school.ca'], subject: expect.stringMatching(/sync failing/i) }));
    expect(send.mock.calls[0][0].html).toContain('503');
    expect(db.query.mock.calls.some(([sql]) => /alerted_at = now\(\)/.test(sql))).toBe(true);
  });

  it('prefers FINANCE_ALERT_EMAIL when set', async () => {
    process.env.FINANCE_ALERT_EMAIL = 'ops@schoolmule.ca';
    mockQueryResponse([]); // markAlerted
    await notifySyncFailure(base);
    expect(Resend.mock.results.at(-1).value.emails.send).toHaveBeenCalledWith(expect.objectContaining({ to: ['ops@schoolmule.ca'] }));
  });

  it('stays quiet within the 24-hour cooldown', async () => {
    const recent = new Date(Date.now() - ALERT_COOLDOWN_MS / 2).toISOString();
    await expect(notifySyncFailure({ ...base, alertedAt: recent })).resolves.toBe(false);
    expect(Resend).not.toHaveBeenCalled();
  });

  it('uses the reconnect wording when the grant is dead', async () => {
    process.env.FINANCE_ALERT_EMAIL = 'ops@schoolmule.ca';
    mockQueryResponse([]);
    await notifySyncFailure({ ...base, needsReconnect: true, consecutiveFailures: 1 });
    expect(Resend.mock.results.at(-1).value.emails.send.mock.calls[0][0].subject).toMatch(/reconnected/i);
  });

  it('never throws, even when sending fails', async () => {
    process.env.FINANCE_ALERT_EMAIL = 'ops@schoolmule.ca';
    Resend.mockImplementationOnce(() => ({ emails: { send: jest.fn().mockRejectedValue(new Error('resend down')) } }));
    await expect(notifySyncFailure(base)).resolves.toBe(false);
  });

  it('treats a Resend { error } result as a failure and does not start the cooldown', async () => {
    process.env.FINANCE_ALERT_EMAIL = 'ops@schoolmule.ca';
    Resend.mockImplementationOnce(() => ({
      emails: { send: jest.fn().mockResolvedValue({ data: null, error: { message: 'from not verified', statusCode: 403 } }) },
    }));
    await expect(notifySyncFailure(base)).resolves.toBe(false);
    expect(db.query.mock.calls.some(([sql]) => /alerted_at = now\(\)/.test(sql))).toBe(false);
  });
});
