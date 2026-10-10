const mockSend = jest.fn();
jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: mockSend } })) }));

const db = require('../../../__mocks__/config/database');
const { mockQueryResponse } = require('../../../helpers/mockDb');
const { notifySyncFailure, ALERT_COOLDOWN_MS } = require('../../../../services/finance/alerts');

const base = { school: 'ALHAADIACADEMY', consecutiveFailures: 3, needsReconnect: false, error: 'QuickBooks server error (503)', alertedAt: null };

describe('alerts.notifySyncFailure', () => {
  beforeEach(() => { mockSend.mockReset(); mockSend.mockResolvedValue({ data: { id: 'e1' } }); });
  afterEach(() => { delete process.env.FINANCE_ALERT_EMAIL; });

  it('emails the school admins and records the alert time', async () => {
    mockQueryResponse([{ email: 'a@school.ca' }, { email: 'b@school.ca' }]);
    mockQueryResponse([]); // markAlerted
    await expect(notifySyncFailure(base)).resolves.toBe(true);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      from: '"SchoolMule" <notification@test.com>',
      to: ['a@school.ca', 'b@school.ca'],
      subject: expect.stringMatching(/sync failing/i),
    }));
    expect(mockSend.mock.calls[0][0].html).toContain('503');
    expect(db.query.mock.calls.some(([sql]) => /alerted_at = now\(\)/.test(sql))).toBe(true);
  });

  it('prefers FINANCE_ALERT_EMAIL when set', async () => {
    process.env.FINANCE_ALERT_EMAIL = 'ops@schoolmule.ca';
    mockQueryResponse([]); // markAlerted
    await notifySyncFailure(base);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: ['ops@schoolmule.ca'] }));
  });

  it('stays quiet within the 24-hour cooldown', async () => {
    const recent = new Date(Date.now() - ALERT_COOLDOWN_MS / 2).toISOString();
    await expect(notifySyncFailure({ ...base, alertedAt: recent })).resolves.toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('uses the reconnect wording when the grant is dead', async () => {
    process.env.FINANCE_ALERT_EMAIL = 'ops@schoolmule.ca';
    mockQueryResponse([]);
    await notifySyncFailure({ ...base, needsReconnect: true, consecutiveFailures: 1 });
    expect(mockSend.mock.calls[0][0].subject).toMatch(/reconnected/i);
  });

  it('never throws, even when sending fails', async () => {
    process.env.FINANCE_ALERT_EMAIL = 'ops@schoolmule.ca';
    mockSend.mockRejectedValue(new Error('resend down'));
    await expect(notifySyncFailure(base)).resolves.toBe(false);
  });

  it('treats a Resend { error } result as a failure and does not start the cooldown', async () => {
    process.env.FINANCE_ALERT_EMAIL = 'ops@schoolmule.ca';
    mockSend.mockResolvedValue({ data: null, error: { message: 'from not verified', statusCode: 403 } });
    await expect(notifySyncFailure(base)).resolves.toBe(false);
    expect(db.query.mock.calls.some(([sql]) => /alerted_at = now\(\)/.test(sql))).toBe(false);
  });
});
