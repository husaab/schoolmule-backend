const db = require('../../../config/database');
const { mockQueryResponse } = require('../../helpers/mockDb');
const {
  hashQrSecret, issueQrSecret, qrToken, parseQrToken, secretMatches, assertStudentCanSignIn,
} = require('../../../services/classroom/studentLogin');

const USER_ID = '550e8400-e29b-41d4-a716-446655440010';
const STUDENT_ID = '660e8400-e29b-41d4-a716-446655440020';
const user = { user_id: USER_ID, school: 'ALHAADIACADEMY' };

// One SIGN_IN_CONTEXT row: classrooms on, a current link, consent recorded,
// logins from Grade 1 and QR cards up to Grade 3.
const context = (overrides = {}) => ({
  enabled: true,
  login_from_grade: '1',
  qr_until_grade: '3',
  consent_at: new Date('2026-10-01T12:00:00Z'),
  qr_secret_hash: 'abc',
  qr_voided_at: null,
  student_id: STUDENT_ID,
  grade: '2',
  ...overrides,
});

const verdictOf = async (row, options) => {
  mockQueryResponse(row ? [row] : []);
  try {
    await assertStudentCanSignIn(user, options);
    return null;
  } catch (v) {
    return v;
  }
};

describe('QR tokens', () => {
  it('parseQrToken round-trips qrToken', () => {
    const { secret } = issueQrSecret();
    expect(secret).toHaveLength(43);
    expect(parseQrToken(qrToken(USER_ID, secret))).toEqual({ userId: USER_ID, secret });
  });

  it('parseQrToken lowercases the user id and trims whitespace', () => {
    const { secret } = issueQrSecret();
    expect(parseQrToken(`  ${qrToken(USER_ID.toUpperCase(), secret)}\n`)).toEqual({ userId: USER_ID, secret });
  });

  it('parseQrToken rejects a 42-character secret', () => {
    const { secret } = issueQrSecret();
    expect(parseQrToken(qrToken(USER_ID, secret.slice(0, 42)))).toBeNull();
  });

  it('parseQrToken rejects garbage, a missing dot and non-strings', () => {
    const { secret } = issueQrSecret();
    expect(parseQrToken('NOT-A-UUID.' + secret)).toBeNull();
    expect(parseQrToken('ZZZZZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZZZZZZZZZ.' + secret)).toBeNull();
    expect(parseQrToken(`${USER_ID}${secret}`)).toBeNull();
    expect(parseQrToken(`${USER_ID}.${secret.slice(0, 42)}!`)).toBeNull();
    expect(parseQrToken(undefined)).toBeNull();
    expect(parseQrToken(null)).toBeNull();
    expect(parseQrToken({ token: 'x' })).toBeNull();
  });

  it('issueQrSecret stores only the SHA-256 of the secret', () => {
    const { secret, hash } = issueQrSecret();
    expect(hash).toBe(hashQrSecret(secret));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(secret);
  });

  it('secretMatches is true only for the issued secret', () => {
    const { secret, hash } = issueQrSecret();
    const other = issueQrSecret().secret;
    expect(secretMatches(secret, hash)).toBe(true);
    expect(secretMatches(other, hash)).toBe(false);
  });

  it('secretMatches is false for a null or malformed hash', () => {
    const { secret } = issueQrSecret();
    expect(secretMatches(secret, null)).toBe(false);
    expect(secretMatches(secret, '')).toBe(false);
    expect(secretMatches(secret, 'abc')).toBe(false);
  });
});

describe('assertStudentCanSignIn', () => {
  it('reads the sign-in context for the user and school', async () => {
    await verdictOf(context());
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('school_classroom_settings');
    expect(sql).toContain('sy.is_active');
    expect(params).toEqual([USER_ID, 'ALHAADIACADEMY']);
  });

  it('is CLASSROOM_DISABLED when the school has not turned classrooms on', async () => {
    expect(await verdictOf(context({ enabled: false }))).toMatchObject({ status: 403, code: 'CLASSROOM_DISABLED' });
    expect(await verdictOf(context({ enabled: null }))).toMatchObject({ code: 'CLASSROOM_DISABLED' });
  });

  it('is CLASSROOM_DISABLED when nothing is found at all', async () => {
    expect(await verdictOf(null)).toMatchObject({ code: 'CLASSROOM_DISABLED' });
  });

  it('is NO_STUDENT_LINK without a link to the active year', async () => {
    expect(await verdictOf(context({ student_id: null, grade: null }))).toMatchObject({
      status: 403, code: 'NO_STUDENT_LINK', message: "Your account isn't set up for this school year yet. Ask your teacher.",
    });
  });

  it('is CONSENT_REQUIRED without a consent record', async () => {
    expect(await verdictOf(context({ consent_at: null }))).toMatchObject({ status: 403, code: 'CONSENT_REQUIRED' });
  });

  it("is GRADE_NOT_ENABLED for SK when logins start at Grade 1", async () => {
    expect(await verdictOf(context({ grade: 'SK', login_from_grade: '1' }))).toMatchObject({
      status: 403, code: 'GRADE_NOT_ENABLED',
    });
  });

  it('is GRADE_NOT_ENABLED for an unknown grade', async () => {
    expect(await verdictOf(context({ grade: '9' }))).toMatchObject({ code: 'GRADE_NOT_ENABLED' });
  });

  it("is QR_NOT_ENABLED for Grade 5 by QR when cards stop at Grade 3", async () => {
    expect(await verdictOf(context({ grade: '5', qr_until_grade: '3' }), { via: 'qr' })).toMatchObject({
      status: 403, code: 'QR_NOT_ENABLED', message: 'Sign in with your email and password.',
    });
  });

  it('lets Grade 5 sign in with a password', async () => {
    expect(await verdictOf(context({ grade: '5', qr_until_grade: '3' }))).toBeNull();
  });

  it('lets Grade 2 sign in by QR and returns the student and card state', async () => {
    mockQueryResponse([context()]);
    await expect(assertStudentCanSignIn(user, { via: 'qr' })).resolves.toEqual({
      studentId: STUDENT_ID, grade: '2', qrSecretHash: 'abc', qrVoidedAt: null,
    });
  });
});
