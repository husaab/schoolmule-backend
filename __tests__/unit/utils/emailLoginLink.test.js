const jwt = require('jsonwebtoken');
const { signEmailLoginToken, verifyEmailLoginToken, emailLoginUrl } = require('../../../utils/emailLoginLink');

describe('emailLoginLink', () => {
  const env = { secret: process.env.JWT_SECRET, url: process.env.FRONTEND_URL };
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
    process.env.FRONTEND_URL = 'https://schoolmule.test';
  });
  afterAll(() => {
    process.env.JWT_SECRET = env.secret;
    process.env.FRONTEND_URL = env.url;
  });

  const claims = { userId: 'u1', studentId: 's1', email: ' Sam.Parent@Example.test ' };

  it('round-trips the parent, the child and the address (lowercased)', () => {
    expect(verifyEmailLoginToken(signEmailLoginToken(claims))).toEqual({ userId: 'u1', studentId: 's1', email: 'sam.parent@example.test' });
  });

  it('lasts 30 days', () => {
    const { exp, iat } = jwt.decode(signEmailLoginToken(claims));
    expect(exp - iat).toBe(30 * 24 * 60 * 60);
  });

  it('never accepts a session token, a token signed with another secret, or an expired one', () => {
    const session = jwt.sign({ userId: 'u1', role: 'PARENT' }, 'test-secret', { subject: 'u1' });
    expect(() => verifyEmailLoginToken(session)).toThrow();
    const token = signEmailLoginToken(claims);
    process.env.JWT_SECRET = 'other-secret';
    expect(() => verifyEmailLoginToken(token)).toThrow();
    process.env.JWT_SECRET = 'test-secret';
    const later = Date.now() + 31 * 24 * 60 * 60 * 1000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect(() => verifyEmailLoginToken(token)).toThrow();
    } finally {
      clock.mockRestore();
    }
    expect(() => verifyEmailLoginToken('')).toThrow();
  });

  it('carries the token in the fragment and the destination in the query', () => {
    const url = new URL(emailLoginUrl({ token: 'abc.def.ghi', next: '/parent/messages?tab=conversations&ask=s1' }));
    expect(url.origin + url.pathname).toBe('https://schoolmule.test/email-login');
    expect(url.searchParams.get('next')).toBe('/parent/messages?tab=conversations&ask=s1');
    expect(url.hash).toBe('#abc.def.ghi');
  });
});
