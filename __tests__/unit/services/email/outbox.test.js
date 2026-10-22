// services/email/outbox.js: what a failed send means for its retry, and the
// idempotency key that makes a retried send harmless. The queue itself
// (claims, merging, retries against Postgres) is covered by
// __tests__/integration/routes/gradesEmailQueue.routes.test.js.

jest.mock('../../../../config/database', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../../../../logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const { classify, idempotencyKey } = require('../../../../services/email/outbox');

const resendError = (name) => Object.assign(new Error(name), { name: 'ResendError', resend: { name, message: name } });

describe('email outbox', () => {
  describe('classify', () => {
    it('reads a reused key whose email Resend already has as sent', () => {
      expect(classify(resendError('invalid_idempotent_request'))).toBe('already_sent');
    });

    it('fails at once what a retry cannot fix', () => {
      for (const name of ['validation_error', 'missing_required_field', 'invalid_parameter', 'invalid_from_address', 'invalid_api_Key']) {
        expect(classify(resendError(name))).toBe('permanent');
      }
    });

    it('retries a refusal for now with a new key (nothing was sent)', () => {
      expect(classify(resendError('rate_limit_exceeded'))).toBe('refused');
      expect(classify(resendError('daily_quota_exceeded'))).toBe('refused');
    });

    it('retries with the same key whatever may have been sent: server errors, timeouts, our own errors', () => {
      expect(classify(resendError('application_error'))).toBe('unknown');
      expect(classify(resendError('internal_server_error'))).toBe('unknown');
      expect(classify(resendError('concurrent_idempotent_requests'))).toBe('unknown');
      expect(classify(new Error('connection reset'))).toBe('unknown');
      expect(classify(undefined)).toBe('unknown');
    });
  });

  describe('idempotencyKey', () => {
    it('is the row and its error count, so it changes only after a definite refusal or a Retry', () => {
      const job = { kind: 'grades_digest', id: '6f1c2a3e-0000-4000-8000-000000000001', error_count: 0 };
      expect(idempotencyKey(job)).toBe('grades_digest:6f1c2a3e-0000-4000-8000-000000000001:0');
      expect(idempotencyKey({ ...job, attempts: 3 })).toBe(idempotencyKey(job));
      expect(idempotencyKey({ ...job, error_count: 1 })).not.toBe(idempotencyKey(job));
    });

    it('names the rows merged into the email: the same set keeps the key, a newer row makes a new one', () => {
      const job = { kind: 'grades_digest', id: '6f1c2a3e-0000-4000-8000-000000000001', error_count: 0 };
      const a = { id: '6f1c2a3e-0000-4000-8000-00000000000a' };
      const b = { id: '6f1c2a3e-0000-4000-8000-00000000000b' };
      expect(idempotencyKey(job, [a, b])).toBe(idempotencyKey(job, [b, a]));
      expect(idempotencyKey(job, [a, b])).not.toBe(idempotencyKey(job, [a]));
      expect(idempotencyKey(job, [a])).not.toBe(idempotencyKey(job));
      expect(idempotencyKey(job, [a, b])).toMatch(/^grades_digest:6f1c2a3e-0000-4000-8000-000000000001:0:[0-9a-f]{16}$/);
    });
  });
});
