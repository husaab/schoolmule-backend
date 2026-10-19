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
  it('a failed email reads failed, before expiry', () => {
    expect(inviteState({ ended_at: null, send_status: 'failed', expires_at: '2026-10-01T00:00:00Z' }, now)).toBe('failed');
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
