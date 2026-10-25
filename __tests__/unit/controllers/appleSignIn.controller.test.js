// POST /api/auth/apple and /api/auth/apple/connect: Sign in with Apple.

jest.mock('resend', () => {
  const send = jest.fn().mockResolvedValue({});
  return { Resend: jest.fn(() => ({ emails: { send } })), __send: send };
});

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('$2b$10$unusablehash'),
  compare: jest.fn().mockResolvedValue(false),
}));

jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid-1234') }));

// The routes share loginLimiter; the limiter has its own suite.
jest.mock('../../../middleware/spamProtection', () => ({
  ...jest.requireActual('../../../middleware/spamProtection'),
  loginLimiter: (req, res, next) => next(),
}));

// Apple itself is out of scope here (see services/apple/appleSignIn.test.js).
jest.mock('../../../services/apple/appleSignIn', () => {
  const actual = jest.requireActual('../../../services/apple/appleSignIn');
  return { ...actual, verifyIdentityToken: jest.fn() };
});

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { generateTestToken, TEST_PARENT_USER_ID } = require('../../helpers/mockAuth');
const { buildUserRow } = require('../../helpers/factories');
const db = require('../../__mocks__/config/database');
const userQueries = require('../../../queries/user.queries');
const classroomSettingsQueries = require('../../../queries/classroomSettings.queries');
const { verifyIdentityToken, AppleSignInError } = require('../../../services/apple/appleSignIn');

const url = '/api/auth/apple';
const BODY = { identityToken: 'apple-token', nonce: 'raw-nonce-0123456789abcdef' };

const APPLE = { sub: 'apple-sub-111', email: 'parent.demo@example.test', emailVerified: true, privateEmail: false };

// Answers queries by their SQL text; anything not listed finds nothing.
const routeQueries = (routes) => {
  db.query.mockImplementation((sql, params) => {
    const handler = routes.get(sql);
    if (handler instanceof Error) return Promise.reject(handler);
    const rows = typeof handler === 'function' ? handler(params) : handler;
    return Promise.resolve({ rows: rows || [], rowCount: (rows || []).length });
  });
};
const callsTo = (sql) => db.query.mock.calls.filter((c) => c[0] === sql);

const settingsSql = Object.values(classroomSettingsQueries).find((sql) => typeof sql === 'string' && /FROM school_classroom_settings/.test(sql) && /WHERE school = \$1/.test(sql));

let app;
beforeAll(() => {
  app = getApp();
});
beforeEach(() => {
  verifyIdentityToken.mockResolvedValue(APPLE);
});

describe('POST /api/auth/apple: request checks', () => {
  it('400s on an unknown intent before calling Apple', async () => {
    const res = await request(app).post(url).send({ ...BODY, intent: 'admin' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Unknown Apple sign-in request.');
    expect(verifyIdentityToken).not.toHaveBeenCalled();
  });

  it('refuses a signup that asks for an admin account', async () => {
    const res = await request(app).post(url).send({ ...BODY, intent: 'signup', school: 'ALHAADIACADEMY', role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/teacher or a parent/);
  });

  it("turns Apple's refusal into a 400 with a retry message", async () => {
    verifyIdentityToken.mockRejectedValue(new AppleSignInError());
    const res = await request(app).post(url).send(BODY);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/try again/i);
  });

  it('hides internal failures behind a generic 500', async () => {
    verifyIdentityToken.mockRejectedValue(new Error("Apple's signing keys answered 503"));
    const res = await request(app).post(url).send(BODY);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Sign in with Apple failed. Please try again.');
  });

  it('passes the token and nonce to the verifier', async () => {
    routeQueries(new Map([[userQueries.selectForAppleSignIn, []]]));
    await request(app).post(url).send(BODY);
    expect(verifyIdentityToken).toHaveBeenCalledWith('apple-token', 'raw-nonce-0123456789abcdef');
  });
});

describe('POST /api/auth/apple: sign in', () => {
  it('answers 404 APPLE_NO_ACCOUNT with the address when nobody matches', async () => {
    routeQueries(new Map([[userQueries.selectForAppleSignIn, []]]));
    const res = await request(app).post(url).send(BODY);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'APPLE_NO_ACCOUNT', data: { email: APPLE.email, privateEmail: false } });
    expect(callsTo(userQueries.createAppleUser)).toHaveLength(0);
  });

  it('says when Apple hid the address, so the app can offer to connect it', async () => {
    verifyIdentityToken.mockResolvedValue({ ...APPLE, email: 'x7k2@privaterelay.appleid.com', privateEmail: true });
    routeQueries(new Map([[userQueries.selectForAppleSignIn, []]]));
    const res = await request(app).post(url).send(BODY);
    expect(res.body).toMatchObject({ code: 'APPLE_NO_ACCOUNT', data: { privateEmail: true } });
  });

  it('opens the account already linked to the Apple ID without touching it', async () => {
    const user = buildUserRow({ role: 'PARENT', email: 'renamed@example.test', apple_sub: APPLE.sub });
    routeQueries(new Map([[userQueries.selectForAppleSignIn, [user]]]));
    const res = await request(app).post(url).send(BODY);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ userId: user.user_id, accountCreated: false });
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(callsTo(userQueries.linkAppleAccount)).toHaveLength(0);
  });

  it('links an account by email and keeps a verified password', async () => {
    const user = buildUserRow({ role: 'PARENT', email: 'Parent.Demo@Example.test' });
    routeQueries(new Map([
      [userQueries.selectForAppleSignIn, [user]],
      [userQueries.linkAppleAccount, (p) => [{ ...user, apple_sub: p[1] }]],
    ]));
    const res = await request(app).post(url).send(BODY);
    expect(res.status).toBe(200);
    expect(callsTo(userQueries.linkAppleAccount)[0][1]).toEqual([user.user_id, APPLE.sub, null]);
  });

  it('never matches by an address Apple has not verified', async () => {
    verifyIdentityToken.mockResolvedValue({ ...APPLE, emailVerified: false });
    routeQueries(new Map([[userQueries.selectForAppleSignIn, []]]));
    await request(app).post(url).send(BODY);
    expect(callsTo(userQueries.selectForAppleSignIn)[0][1]).toEqual([APPLE.sub, null]);
  });

  it('refuses an account linked to a different Apple ID', async () => {
    const user = buildUserRow({ role: 'PARENT', email: APPLE.email, apple_sub: 'someone-else' });
    routeQueries(new Map([[userQueries.selectForAppleSignIn, [user]]]));
    const res = await request(app).post(url).send(BODY);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/different Apple account/);
  });

  it("refuses a student whose invite isn't accepted yet", async () => {
    const user = buildUserRow({ role: 'STUDENT', email: APPLE.email, password: '!' });
    routeQueries(new Map([[userQueries.selectForAppleSignIn, [user]]]));
    const res = await request(app).post(url).send(BODY);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('APPLE_INVITE_PENDING');
    expect(callsTo(userQueries.linkAppleAccount)).toHaveLength(0);
  });

  it("refuses a student on the school's Google Workspace student domain", async () => {
    const user = buildUserRow({ role: 'STUDENT', email: 'amina@students.example.test' });
    verifyIdentityToken.mockResolvedValue({ ...APPLE, email: user.email });
    routeQueries(new Map([
      [userQueries.selectForAppleSignIn, [user]],
      [settingsSql, [{ school: user.school, enabled: true, student_email_domains: ['students.example.test'], student_sign_in: 'google_or_password' }]],
    ]));
    const res = await request(app).post(url).send(BODY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('APPLE_WRONG_DOMAIN');
  });

  it('refuses a student at a Google-only school', async () => {
    const user = buildUserRow({ role: 'STUDENT', email: APPLE.email });
    routeQueries(new Map([
      [userQueries.selectForAppleSignIn, [user]],
      [settingsSql, [{ school: user.school, enabled: true, student_email_domains: [], student_sign_in: 'google_only' }]],
    ]));
    const res = await request(app).post(url).send(BODY);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('APPLE_NOT_ALLOWED');
  });
});

describe('POST /api/auth/apple: sign up', () => {
  it('creates a pending account with the name the app passed on', async () => {
    routeQueries(new Map([
      [userQueries.selectForAppleSignIn, []],
      [userQueries.createAppleUser, (p) => [buildUserRow({ user_id: p[0], email: p[1], role: p[7], apple_sub: p[8], is_verified_school: false })]],
    ]));
    const res = await request(app).post(url).send({ ...BODY, intent: 'signup', school: 'ALHAADIACADEMY', role: 'PARENT', givenName: ' Demo ', familyName: 'Parent' });
    expect(res.status).toBe(200);
    expect(res.body.data.accountCreated).toBe(true);
    const params = callsTo(userQueries.createAppleUser)[0][1];
    expect(params.slice(1, 3)).toEqual([APPLE.email, 'Demo Parent']);
    expect(params.slice(4, 9)).toEqual(['Demo', 'Parent', 'ALHAADIACADEMY', 'PARENT', APPLE.sub]);
  });

  it("can't create an account without an address Apple vouches for", async () => {
    verifyIdentityToken.mockResolvedValue({ ...APPLE, email: null, emailVerified: false });
    routeQueries(new Map([[userQueries.selectForAppleSignIn, []]]));
    const res = await request(app).post(url).send({ ...BODY, intent: 'signup', school: 'ALHAADIACADEMY', role: 'PARENT' });
    expect(res.status).toBe(404);
    expect(callsTo(userQueries.createAppleUser)).toHaveLength(0);
  });
});

describe('POST /api/auth/apple/connect', () => {
  const auth = () => `Bearer ${generateTestToken({ userId: TEST_PARENT_USER_ID, role: 'PARENT' })}`;
  const parent = buildUserRow({ user_id: TEST_PARENT_USER_ID, role: 'PARENT' });

  it('needs a signed-in account', async () => {
    const res = await request(app).post('/api/auth/apple/connect').send(BODY);
    expect(res.status).toBe(401);
    expect(verifyIdentityToken).not.toHaveBeenCalled();
  });

  it("stamps the caller's account with the Apple ID", async () => {
    routeQueries(new Map([
      [userQueries.selectById, [parent]],
      [userQueries.connectAppleId, [{ user_id: parent.user_id }]],
    ]));
    const res = await request(app).post('/api/auth/apple/connect').set('Authorization', auth()).send(BODY);
    expect(res.status).toBe(200);
    expect(callsTo(userQueries.connectAppleId)[0][1]).toEqual([parent.user_id, APPLE.sub]);
  });

  it('refuses an Apple ID another account already uses', async () => {
    routeQueries(new Map([[userQueries.selectById, [parent]], [userQueries.connectAppleId, []]]));
    const res = await request(app).post('/api/auth/apple/connect').set('Authorization', auth()).send(BODY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('APPLE_IN_USE');
  });

  it('refuses when the account already has a different Apple ID', async () => {
    routeQueries(new Map([[userQueries.selectById, [{ ...parent, apple_sub: 'other' }]], [userQueries.connectAppleId, []]]));
    const res = await request(app).post('/api/auth/apple/connect').set('Authorization', auth()).send(BODY);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('APPLE_OTHER_ID');
  });
});
