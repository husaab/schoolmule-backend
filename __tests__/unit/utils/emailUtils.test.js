jest.mock('../../../logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const logger = require('../../../logger');
const {
  cleanEmailArray, getResend, sendOrThrow, sendSafely, isReservedAddress, withReservedDomainGuard,
} = require('../../../utils/emailUtils');

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

  describe('getResend', () => {
    it('returns one shared client for the whole process', () => {
      expect(getResend()).toBe(getResend());
      expect(typeof getResend().emails.send).toBe('function');
    });
  });

  describe('isReservedAddress', () => {
    it('matches the names RFC 2606 and RFC 6761 reserve, and their subdomains', () => {
      for (const address of [
        'parent@playground.test', 'kid@students.playground.test', 'p@example.com', 'p@mail.example.org',
        'p@example.net', 'p@site.example', 'p@nowhere.invalid', 'p@localhost', 'P@EXAMPLE.COM',
      ]) {
        expect(isReservedAddress(address)).toBe(true);
      }
    });

    it('reads the address out of a "Name <address>" recipient', () => {
      expect(isReservedAddress('Amal Haddad <parent@playground.test>')).toBe(true);
      expect(isReservedAddress('Amal Haddad <amal@gmail.com>')).toBe(false);
    });

    it('leaves real domains alone, including ones that only look alike', () => {
      for (const address of ['a@gmail.com', 'a@schoolmule.ca', 'a@contest.ca', 'a@myexample.com', 'a@example.co', 'nope', '']) {
        expect(isReservedAddress(address)).toBe(false);
      }
    });
  });

  describe('withReservedDomainGuard', () => {
    it('never calls Resend when every recipient is reserved, and answers like an accepted send', async () => {
      const inner = resolving({ data: { id: 'em_1' }, error: null });
      const send = inner.emails.send;
      const client = withReservedDomainGuard(inner);
      const result = await client.emails.send({ ...payload, to: ['parent@playground.test'], cc: ['p@example.com'] });
      expect(result).toEqual({ data: { id: 'suppressed' }, error: null });
      expect(send).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ suppressed: ['parent@playground.test', 'p@example.com'] }),
        expect.any(String),
      );
    });

    it('drops only the reserved recipients from a mixed send', async () => {
      const inner = resolving({ data: { id: 'em_2' }, error: null });
      const send = inner.emails.send;
      const client = withReservedDomainGuard(inner);
      await expect(client.emails.send({
        ...payload, to: ['a@gmail.com', 'parent@playground.test'], cc: 'p@example.com', bcc: ['b@schoolmule.ca'],
      })).resolves.toEqual({ data: { id: 'em_2' }, error: null });
      expect(send).toHaveBeenCalledWith({ ...payload, to: ['a@gmail.com'], cc: [], bcc: ['b@schoolmule.ca'] });
    });

    it('passes a send with no reserved recipient through untouched', async () => {
      const inner = resolving({ data: { id: 'em_3' }, error: null });
      const send = inner.emails.send;
      const real = { ...payload, to: 'a@gmail.com' };
      await withReservedDomainGuard(inner).emails.send(real);
      expect(send).toHaveBeenCalledWith(real);
    });

    it('moves a real cc into "to" when every "to" was reserved, since Resend needs a "to"', async () => {
      const inner = resolving({ data: { id: 'em_4' }, error: null });
      const send = inner.emails.send;
      await withReservedDomainGuard(inner).emails.send({ ...payload, to: 'parent@playground.test', cc: ['a@gmail.com'] });
      expect(send).toHaveBeenCalledWith({ ...payload, to: ['a@gmail.com'], cc: [] });
    });

    it('never turns bcc into a visible "to": with only bcc left it is not sent', async () => {
      const inner = resolving({ data: { id: 'em_5' }, error: null });
      const send = inner.emails.send;
      const result = await withReservedDomainGuard(inner).emails.send({ ...payload, to: 'parent@playground.test', bcc: ['a@gmail.com', 'b@gmail.com'] });
      expect(send).not.toHaveBeenCalled();
      expect(result).toEqual({ data: { id: 'suppressed' }, error: null });
    });
  });

  describe('getResend and EMAIL_DELIVER_RESERVED_DOMAINS', () => {
    const original = process.env.EMAIL_DELIVER_RESERVED_DOMAINS;
    afterEach(() => {
      if (original === undefined) delete process.env.EMAIL_DELIVER_RESERVED_DOMAINS;
      else process.env.EMAIL_DELIVER_RESERVED_DOMAINS = original;
    });

    const freshClient = () => {
      let client;
      jest.isolateModules(() => {
        jest.doMock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'em' } }) } })) }));
        client = require('../../../utils/emailUtils').getResend();
      });
      return client;
    };

    it('guards the shared client by default', async () => {
      delete process.env.EMAIL_DELIVER_RESERVED_DOMAINS;
      await expect(freshClient().emails.send({ ...payload, to: 'p@example.com' })).resolves.toEqual({ data: { id: 'suppressed' }, error: null });
    });

    it('hands back the raw client when the switch is on (tests, local smoke capture)', () => {
      process.env.EMAIL_DELIVER_RESERVED_DOMAINS = 'true';
      expect(jest.isMockFunction(freshClient().emails.send)).toBe(true);
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
