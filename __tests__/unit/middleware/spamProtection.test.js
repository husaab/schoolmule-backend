jest.mock('../../../logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const {
  signupLimiter,
  verificationEmailLimiter,
  passwordResetLimiter,
  contactFormLimiter,
  loginLimiter,
  honeypotValidation,
  validateInput,
} = require('../../../middleware/spamProtection');

describe('spamProtection middleware', () => {
  describe('rate limiters are exported correctly', () => {
    it('exports signupLimiter as a function', () => {
      expect(typeof signupLimiter).toBe('function');
    });

    it('exports verificationEmailLimiter as a function', () => {
      expect(typeof verificationEmailLimiter).toBe('function');
    });

    it('exports passwordResetLimiter as a function', () => {
      expect(typeof passwordResetLimiter).toBe('function');
    });

    it('exports contactFormLimiter as a function', () => {
      expect(typeof contactFormLimiter).toBe('function');
    });

    it('exports loginLimiter as a function', () => {
      expect(typeof loginLimiter).toBe('function');
    });
  });

  describe('honeypotValidation', () => {
    let req, res, next;

    beforeEach(() => {
      req = { body: {}, ip: '127.0.0.1' };
      res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      next = jest.fn();
    });

    it('calls next() when honeypot fields are empty', () => {
      req.body = { name: 'John', message: 'Hello' };

      honeypotValidation(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 200 (silent) when website honeypot is filled', () => {
      req.body = { name: 'Bot', message: 'Spam', website: 'http://spam.com' };

      honeypotValidation(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Request processed successfully',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 200 (silent) when url honeypot is filled', () => {
      req.body = { name: 'Bot', url: 'http://spam.com' };

      honeypotValidation(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 200 (silent) when homepage honeypot is filled', () => {
      req.body = { name: 'Bot', homepage: 'http://spam.com' };

      honeypotValidation(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('validateInput', () => {
    let req, res, next;

    beforeEach(() => {
      req = { body: {}, ip: '127.0.0.1' };
      res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      next = jest.fn();
    });

    it('calls next() for clean input', () => {
      req.body = { name: 'John Doe', message: 'Hello, I need help.' };

      validateInput(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('returns 400 when name contains URL shortener', () => {
      req.body = { name: 'Check bit.ly/spam', message: 'Normal message' };

      validateInput(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        message: 'Invalid content detected',
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 400 when message contains URL shortener', () => {
      req.body = { name: 'John', message: 'Visit tinyurl.com/malware' };

      validateInput(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 400 for excessive emojis in message', () => {
      req.body = { name: 'John', message: '😀😀😀😀😀😀' };

      validateInput(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
    });

    it('allows normal emoji usage (less than 5)', () => {
      req.body = { name: 'John', message: 'Great job! 👍🎉' };

      validateInput(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('handles missing name and message gracefully', () => {
      req.body = {};

      validateInput(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
