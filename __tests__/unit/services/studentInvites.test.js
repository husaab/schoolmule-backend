const {
  INVITE_VALID_DAYS, issueInviteSecret, hashInviteSecret, parseInviteToken, inviteUrl, inviteState, formatInviteDate,
} = require('../../../services/classroom/studentInvites');

describe('invite secrets', () => {
  it('are 43 base64url characters whose SHA-256 is the stored hash', () => {
    const { secret, hash } = issueInviteSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteSecret(secret)).toBe(hash);
    expect(issueInviteSecret().secret).not.toBe(secret);
  });

  it('parseInviteToken accepts exactly one secret, trimmed, and nothing else', () => {
    const { secret } = issueInviteSecret();
    expect(parseInviteToken(` ${secret} `)).toBe(secret);
    expect(parseInviteToken(secret.slice(1))).toBeNull();
    expect(parseInviteToken(`${secret}a`)).toBeNull();
    expect(parseInviteToken(`${secret.slice(1)}+`)).toBeNull();
    expect(parseInviteToken(`${secret.slice(1)}/`)).toBeNull();
    expect(parseInviteToken(null)).toBeNull();
    expect(parseInviteToken({ secret })).toBeNull();
  });

  it('the link carries the secret in its fragment', () => {
    const old = process.env.FRONTEND_URL;
    process.env.FRONTEND_URL = 'https://app.example.org';
    expect(inviteUrl('abc')).toBe('https://app.example.org/student-invite#abc');
    process.env.FRONTEND_URL = old;
  });
});

describe('inviteState', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const future = '2026-11-03T12:00:00Z';
  it('an ended invite reads how it ended', () => {
    expect(inviteState({ ended_at: now, end_reason: 'replaced', send_status: 'sent', expires_at: future }, now)).toBe('replaced');
  });
  it('a failed email reads failed until the link expires, then expired (it may have been delivered)', () => {
    expect(inviteState({ ended_at: null, send_status: 'failed', expires_at: future }, now)).toBe('failed');
    expect(inviteState({ ended_at: null, send_status: 'failed', expires_at: '2026-10-01T00:00:00Z' }, now)).toBe('expired');
  });
  it('past its expiry reads expired; otherwise pending', () => {
    expect(inviteState({ ended_at: null, send_status: 'sent', expires_at: '2026-10-20T11:59:59Z' }, now)).toBe('expired');
    expect(inviteState({ ended_at: null, send_status: 'sent', expires_at: future }, now)).toBe('pending');
  });
});

describe('formatInviteDate', () => {
  it('is the Toronto weekday and date', () => {
    // 03:00 UTC on Nov 3 is still Monday Nov 2 in Toronto.
    expect(formatInviteDate(new Date('2026-11-03T03:00:00Z'))).toBe('Monday, November 2');
  });
  it('a link lasts 14 days', () => {
    expect(INVITE_VALID_DAYS).toBe(14);
  });
});

describe('passwordProblem', () => {
  const ctx = { email: 'amal.haddad@students.example.org', firstName: 'Amal', lastName: 'Haddad', schoolName: 'Al Haadi Academy' };
  const { passwordProblem } = require('../../../services/classroom/studentInvites');
  it.each([
    ['short1', 'Use at least 8 characters.'],
    ['amal.haddad', "Don't use your email address."],
    ['amal.haddad2026', "Don't use your email address."],
    ['amalhaddad1', "Don't use your name in your password."],
    ['Haddad-family', "Don't use your name in your password."],
    ['password', 'Choose something harder to guess.'],
    ['12345678', 'Choose something harder to guess.'],
    ['alhaadiacademy1', 'Choose something harder to guess.'],
  ])('refuses %p', (pw, message) => {
    expect(passwordProblem(pw, ctx)).toBe(message);
  });
  it('accepts a passphrase that is none of those', () => {
    expect(passwordProblem('cedar-river', ctx)).toBeNull();
    expect(passwordProblem('maple lake 42', ctx)).toBeNull();
  });
  it('refuses a non-string', () => {
    expect(passwordProblem(undefined, ctx)).toBe('Use at least 8 characters.');
  });
});

describe('acceptGoogleChecks', () => {
  const { acceptGoogleChecks } = require('../../../services/classroom/studentInvites');
  const user = { email: 'amal.haddad@students.example.org' };
  const google = (o = {}) => ({ email: 'Amal.Haddad@students.example.org', emailVerified: true, hd: 'students.example.org', ...o });
  it('passes the same address (any case) from the school Workspace', () => {
    expect(acceptGoogleChecks(google(), user, ['students.example.org'])).toBeNull();
  });
  it('refuses an unverified Google address', () => {
    expect(acceptGoogleChecks(google({ emailVerified: false }), user, [])).toMatchObject({ status: 403, code: 'GOOGLE_UNVERIFIED' });
  });
  it('refuses another address, naming both', () => {
    expect(acceptGoogleChecks(google({ email: 'mona@example.com' }), user, [])).toEqual({
      status: 409,
      code: 'GOOGLE_WRONG_ACCOUNT',
      message: 'That Google account is mona@example.com. This invite is for amal.haddad@students.example.org.',
    });
  });
  it('on a declared domain, refuses a Google account outside that Workspace', () => {
    expect(acceptGoogleChecks(google({ hd: null }), user, ['students.example.org'])).toMatchObject({ code: 'GOOGLE_WRONG_DOMAIN' });
    expect(acceptGoogleChecks(google({ hd: 'other.org' }), user, ['students.example.org'])).toMatchObject({ code: 'GOOGLE_WRONG_DOMAIN' });
  });
  it('with no declared domain, a personal Google account is fine', () => {
    expect(acceptGoogleChecks(google({ hd: null }), user, [])).toBeNull();
  });
});

describe('publicInviteState', () => {
  const { publicInviteState } = require('../../../services/classroom/studentInvites');
  const now = new Date('2026-10-20T12:00:00Z');
  const live = { user_id: 'u', ended_at: null, send_status: 'sent', expires_at: '2026-11-01T00:00:00Z' };
  it('maps every row to what the page says', () => {
    expect(publicInviteState(live, now)).toBe('valid');
    expect(publicInviteState({ ...live, send_status: 'failed' }, now)).toBe('valid');
    expect(publicInviteState({ ...live, send_status: 'failed', expires_at: '2026-10-01T00:00:00Z' }, now)).toBe('expired');
    expect(publicInviteState({ ...live, expires_at: '2026-10-01T00:00:00Z' }, now)).toBe('expired');
    expect(publicInviteState({ ...live, ended_at: now, end_reason: 'accepted' }, now)).toBe('used');
    expect(publicInviteState({ ...live, ended_at: now, end_reason: 'replaced' }, now)).toBe('replaced');
    for (const reason of ['cancelled', 'email_changed', 'archived']) {
      expect(publicInviteState({ ...live, ended_at: now, end_reason: reason }, now)).toBe('cancelled');
    }
    expect(publicInviteState({ ...live, user_id: null }, now)).toBe('cancelled');
  });
});
