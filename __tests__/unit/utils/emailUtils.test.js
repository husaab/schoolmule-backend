jest.mock('../../../logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const logger = require('../../../logger');
const { cleanEmailArray, getSchoolApiKey, getSchoolDomain, sendOrThrow, sendSafely } = require('../../../utils/emailUtils');

const payload = { from: 'verify@schoolmule.ca', to: 'p@example.com', subject: 's', html: '<p>x</p>' };
// A Resend client whose send() resolves with `result`.
const resolving = (result) => ({ emails: { send: jest.fn().mockResolvedValue(result) } });
const rejecting = (err) => ({ emails: { send: jest.fn().mockRejectedValue(err) } });

describe('emailUtils', () => {
  describe('cleanEmailArray', () => {
    it('trims, drops blanks and keeps only addresses with an @', () => {
      expect(cleanEmailArray([' a@x.ca ', '', 'nope', null, 'b@y.ca'])).toEqual(['a@x.ca', 'b@y.ca']);
    });

    it('returns [] for non-arrays', () => {
      expect(cleanEmailArray(undefined)).toEqual([]);
      expect(cleanEmailArray('a@x.ca')).toEqual([]);
    });
  });

  describe('getSchoolApiKey / getSchoolDomain', () => {
    const saved = {};
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    beforeEach(() => {
      saved.shared = process.env.RESEND_API_KEY;
      saved.school = process.env.ALHAADIACADEMY_RESEND_API_KEY;
    });
    afterEach(() => {
      restore('RESEND_API_KEY', saved.shared);
      restore('ALHAADIACADEMY_RESEND_API_KEY', saved.school);
    });

    it('prefers the school-specific key and falls back to the shared one', () => {
      process.env.RESEND_API_KEY = 'shared';
      delete process.env.ALHAADIACADEMY_RESEND_API_KEY;
      expect(getSchoolApiKey('ALHAADIACADEMY')).toBe('shared');
      process.env.ALHAADIACADEMY_RESEND_API_KEY = 'school';
      expect(getSchoolApiKey('Al Haadi Academy')).toBe('school');
    });

    it('maps Al Haadi to its own domain and everyone else to schoolmule.ca', () => {
      expect(getSchoolDomain('ALHAADIACADEMY')).toBe('alhaadiacademy.ca');
      expect(getSchoolDomain('PLAYGROUND')).toBe('schoolmule.ca');
    });
  });

  describe('sendOrThrow', () => {
    it('returns the SDK result when Resend accepts the email', async () => {
      const client = resolving({ data: { id: 'em_1' }, error: null });
      await expect(sendOrThrow(client, payload)).resolves.toEqual({ data: { id: 'em_1' }, error: null });
      expect(client.emails.send).toHaveBeenCalledWith(payload);
    });

    it('treats a result without an error key as success', async () => {
      await expect(sendOrThrow(resolving({}), payload)).resolves.toEqual({});
      await expect(sendOrThrow(resolving(undefined), payload)).resolves.toBeUndefined();
    });

    it('throws when Resend resolves with an error instead of throwing', async () => {
      const error = { name: 'validation_error', message: 'The from address is not verified', statusCode: 403 };
      await expect(sendOrThrow(resolving({ data: null, error }), payload)).rejects.toMatchObject({
        name: 'ResendError',
        message: 'The from address is not verified',
        resend: error,
      });
    });

    it("does not copy Resend's HTTP status onto the thrown error", async () => {
      const client = resolving({ data: null, error: { message: 'rate limited', statusCode: 429 } });
      const err = await sendOrThrow(client, payload).catch((e) => e);
      expect(err.status).toBeUndefined();
      expect(err.statusCode).toBeUndefined();
    });

    it('uses a generic message when the error has none', async () => {
      await expect(sendOrThrow(resolving({ error: {} }), payload)).rejects.toThrow('Email sending failed');
    });

    it('lets a real rejection propagate untouched', async () => {
      const boom = new Error('network down');
      await expect(sendOrThrow(rejecting(boom), payload)).rejects.toBe(boom);
    });
  });

  describe('sendSafely', () => {
    it('returns true when the email is accepted', async () => {
      await expect(sendSafely(resolving({ data: { id: 'em_1' } }), payload, 'nope')).resolves.toBe(true);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('returns false and logs with context when Resend rejects the email', async () => {
      const client = resolving({ data: null, error: { message: 'from not verified', statusCode: 403 } });
      await expect(sendSafely(client, payload, 'Invite failed', { userId: 'u1' })).resolves.toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', err: expect.objectContaining({ message: 'from not verified' }) }),
        'Invite failed',
      );
    });

    it('returns false when the send throws', async () => {
      await expect(sendSafely(rejecting(new Error('down')), payload, 'Invite failed')).resolves.toBe(false);
    });
  });
});
