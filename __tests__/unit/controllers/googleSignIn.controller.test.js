// POST /api/auth/google: sign in / sign up with Google.

// One shared send mock so tests can count the emails a request sent.
jest.mock('resend', () => {
  const send = jest.fn().mockResolvedValue({});
  return {
    Resend: jest.fn(() => ({ emails: { send } })),
    __send: send,
  };
});

jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('$2b$10$unusablehash'),
  compare: jest.fn().mockResolvedValue(false),
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-1234'),
}));

// The route shares loginLimiter (10 per 15 min per IP), which this file's
// requests would exhaust; the limiter has its own suite.
jest.mock('../../../middleware/spamProtection', () => ({
  ...jest.requireActual('../../../middleware/spamProtection'),
  loginLimiter: (req, res, next) => next(),
}));

// Google itself is out of scope here (see services/google/googleSignIn.test.js):
// each test decides which identity the popup code turns into.
jest.mock('../../../services/google/googleSignIn', () => {
  const actual = jest.requireActual('../../../services/google/googleSignIn');
  return { ...actual, verifySignInCode: jest.fn() };
});

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { getApp } = require('../../helpers/testApp');
const { JWT_SECRET } = require('../../helpers/mockAuth');
const { buildUserRow } = require('../../helpers/factories');
const { __send: mockSend } = require('resend');
const bcrypt = require('bcrypt');
const db = require('../../__mocks__/config/database');
const userQueries = require('../../../queries/user.queries');
const { verifySignInCode, GoogleSignInError } = require('../../../services/google/googleSignIn');
// Sign-up notices go to the school's approvers (services/access/recipients.js).
const { SQL: recipientsSql } = require('../../../services/access/recipients');

const url = '/api/auth/google';

const GOOGLE = {
  sub: 'google-sub-111',
  email: 'parent.demo@example.com',
  emailVerified: true,
  givenName: 'Demo',
  familyName: 'Parent',
  name: 'Demo Parent',
};

// Answers queries by their SQL text, so a test states what the database holds
// rather than the order the controller happens to ask in. Anything not listed
// (term, school years, last_login_at) finds nothing.
const routeQueries = (routes) => {
  db.query.mockImplementation((sql, params) => {
    const handler = routes.get(sql);
    if (handler instanceof Error) return Promise.reject(handler);
    const rows = typeof handler === 'function' ? handler(params) : handler;
    return Promise.resolve({ rows: rows || [], rowCount: (rows || []).length });
  });
};

const callsTo = (sql) => db.query.mock.calls.filter((c) => c[0] === sql);

let app;
beforeAll(() => {
  app = getApp();
});

beforeEach(() => {
  verifySignInCode.mockResolvedValue(GOOGLE);
});

describe('POST /api/auth/google: request checks', () => {
  it('400s without a code and never calls Google', async () => {
    const res = await request(app).post(url).send({ intent: 'login' });
    expect(res.status).toBe(400);
    expect(verifySignInCode).not.toHaveBeenCalled();
  });

  it('400s on an unknown intent', async () => {
    const res = await request(app).post(url).send({ code: 'c', intent: 'admin' });
    expect(res.status).toBe(400);
  });

  it('refuses a signup that asks for an admin account', async () => {
    const res = await request(app).post(url).send({ code: 'c', intent: 'signup', school: 'ALHAADIACADEMY', role: 'ADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/teacher or a parent/);
    expect(verifySignInCode).not.toHaveBeenCalled();
  });

  it('refuses a signup without a school', async () => {
    const res = await request(app).post(url).send({ code: 'c', intent: 'signup', role: 'PARENT' });
    expect(res.status).toBe(400);
  });

  it('turns an expired or reused code into a 400 with a retry message', async () => {
    verifySignInCode.mockRejectedValue(new GoogleSignInError());
    const res = await request(app).post(url).send({ code: 'c' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/try again/i);
  });

  it('hides internal failures behind a generic 500', async () => {
    verifySignInCode.mockRejectedValue(new Error('Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)'));
    const res = await request(app).post(url).send({ code: 'c' });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Google sign-in failed. Please try again.');
  });

  it('refuses a Google account whose email Google has not verified, before looking anyone up', async () => {
    verifySignInCode.mockResolvedValue({ ...GOOGLE, emailVerified: false });
    routeQueries(new Map());
    const res = await request(app).post(url).send({ code: 'c' });
    expect(res.status).toBe(403);
    expect(callsTo(userQueries.selectForGoogleSignIn)).toHaveLength(0);
  });
});

describe('POST /api/auth/google: sign in', () => {
  it('answers 404 GOOGLE_NO_ACCOUNT with the Google email when nobody matches', async () => {
    routeQueries(new Map([[userQueries.selectForGoogleSignIn, []]]));

    const res = await request(app).post(url).send({ code: 'c', intent: 'login' });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'GOOGLE_NO_ACCOUNT', data: { email: GOOGLE.email } });
    expect(callsTo(userQueries.createGoogleUser)).toHaveLength(0);
  });

  it('defaults to login when no intent is sent', async () => {
    routeQueries(new Map([[userQueries.selectForGoogleSignIn, []]]));
    const res = await request(app).post(url).send({ code: 'c' });
    expect(res.status).toBe(404);
  });

  it('looks accounts up by Google id and by email', async () => {
    routeQueries(new Map([[userQueries.selectForGoogleSignIn, []]]));
    await request(app).post(url).send({ code: 'c' });
    expect(callsTo(userQueries.selectForGoogleSignIn)[0][1]).toEqual([GOOGLE.sub, GOOGLE.email]);
  });

  it('links an existing password account by email on first use and signs in', async () => {
    const user = buildUserRow({ email: GOOGLE.email, role: 'PARENT', google_sub: null });
    routeQueries(new Map([
      [userQueries.selectForGoogleSignIn, [user]],
      [userQueries.linkGoogleAccount, ([userId, sub]) => [{ ...user, user_id: userId, google_sub: sub }]],
    ]));

    const res = await request(app).post(url).send({ code: 'c', intent: 'login' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ userId: user.user_id, role: 'PARENT', accountCreated: false });
    // Their password stays: no replacement hash is passed.
    expect(callsTo(userQueries.linkGoogleAccount)[0][1]).toEqual([user.user_id, GOOGLE.sub, null]);
    expect(bcrypt.hash).not.toHaveBeenCalled();
    const claims = jwt.verify(res.body.data.token, JWT_SECRET);
    expect(claims).toMatchObject({ userId: user.user_id, role: 'PARENT', isVerified: true, isVerifiedSchool: true });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('matches the email ignoring case', async () => {
    const user = buildUserRow({ email: 'Parent.Demo@Example.com', google_sub: null });
    routeQueries(new Map([
      [userQueries.selectForGoogleSignIn, [user]],
      [userQueries.linkGoogleAccount, [{ ...user, google_sub: GOOGLE.sub }]],
    ]));

    const res = await request(app).post(url).send({ code: 'c' });

    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(user.user_id);
  });

  it('signs a linked account in without writing to it', async () => {
    const user = buildUserRow({ email: 'old.address@example.com', google_sub: GOOGLE.sub });
    routeQueries(new Map([[userQueries.selectForGoogleSignIn, [user]]]));

    const res = await request(app).post(url).send({ code: 'c' });

    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(user.user_id);
    expect(callsTo(userQueries.linkGoogleAccount)).toHaveLength(0);
  });

  it('prefers the account linked to this Google id over another that only shares the email', async () => {
    const linked = buildUserRow({ email: 'old.address@example.com', google_sub: GOOGLE.sub });
    const sameEmail = buildUserRow({ email: GOOGLE.email, google_sub: null });
    routeQueries(new Map([[userQueries.selectForGoogleSignIn, [sameEmail, linked]]]));

    const res = await request(app).post(url).send({ code: 'c' });

    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(linked.user_id);
  });

  it('accepts a pending invite: the "!" sentinel is replaced by an unusable hash', async () => {
    const user = buildUserRow({ email: GOOGLE.email, password: '!', google_sub: null });
    routeQueries(new Map([
      [userQueries.selectForGoogleSignIn, [user]],
      [userQueries.linkGoogleAccount, ([, sub, password]) => [{ ...user, google_sub: sub, password }]],
    ]));

    const res = await request(app).post(url).send({ code: 'c' });

    expect(res.status).toBe(200);
    expect(callsTo(userQueries.linkGoogleAccount)[0][1]).toEqual([user.user_id, GOOGLE.sub, '$2b$10$unusablehash']);
  });

  it('counts Google as email verification for an unverified signup and sends the verified emails', async () => {
    const user = buildUserRow({ email: GOOGLE.email, role: 'PARENT', is_verified: false, is_verified_school: false, google_sub: null });
    routeQueries(new Map([
      [userQueries.selectForGoogleSignIn, [user]],
      [userQueries.linkGoogleAccount, [{ ...user, is_verified: true, google_sub: GOOGLE.sub }]],
      [recipientsSql, [{ email: 'admin.demo@example.com' }]],
    ]));

    const res = await request(app).post(url).send({ code: 'c' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ isVerified: true, isVerifiedSchool: false });
    const subjects = mockSend.mock.calls.map(([msg]) => msg.subject);
    expect(subjects).toEqual(['Your Email Has Been Verified at School Mule', 'New User Awaiting School Approval']);
  });

  it('replaces a password set before the email was verified (someone else may have signed up with it)', async () => {
    const squatted = buildUserRow({ email: GOOGLE.email, password: '$2b$10$squatterhash', is_verified: false, is_verified_school: false, google_sub: null });
    routeQueries(new Map([
      [userQueries.selectForGoogleSignIn, [squatted]],
      [userQueries.linkGoogleAccount, ([, sub, password]) => [{ ...squatted, is_verified: true, google_sub: sub, password }]],
    ]));

    const res = await request(app).post(url).send({ code: 'c' });

    expect(res.status).toBe(200);
    expect(callsTo(userQueries.linkGoogleAccount)[0][1]).toEqual([squatted.user_id, GOOGLE.sub, '$2b$10$unusablehash']);
  });

  it('still replaces an unverified password when the Google id is already linked', async () => {
    const user = buildUserRow({ email: GOOGLE.email, is_verified: false, is_verified_school: false, google_sub: GOOGLE.sub });
    routeQueries(new Map([
      [userQueries.selectForGoogleSignIn, [user]],
      [userQueries.linkGoogleAccount, [{ ...user, is_verified: true }]],
    ]));

    await request(app).post(url).send({ code: 'c' });

    expect(callsTo(userQueries.linkGoogleAccount)[0][1][2]).toBe('$2b$10$unusablehash');
  });

  it('signs in even when the admin lookup for the approval email fails', async () => {
    const user = buildUserRow({ email: GOOGLE.email, role: 'PARENT', is_verified: false, is_verified_school: false, google_sub: null });
    routeQueries(new Map([
      [userQueries.selectForGoogleSignIn, [user]],
      [userQueries.linkGoogleAccount, [{ ...user, is_verified: true, google_sub: GOOGLE.sub }]],
      [recipientsSql, new Error('connection reset')],
    ]));

    const res = await request(app).post(url).send({ code: 'c' });

    expect(res.status).toBe(200);
  });

  it('refuses an archived account and leaves it untouched', async () => {
    const user = buildUserRow({ email: GOOGLE.email, is_archived: true, google_sub: null });
    routeQueries(new Map([[userQueries.selectForGoogleSignIn, [user]]]));

    const res = await request(app).post(url).send({ code: 'c' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/archived/);
    expect(callsTo(userQueries.linkGoogleAccount)).toHaveLength(0);
  });

  it('refuses an email whose account is linked to a different Google account', async () => {
    const user = buildUserRow({ email: GOOGLE.email, google_sub: 'someone-else' });
    routeQueries(new Map([[userQueries.selectForGoogleSignIn, [user]]]));

    const res = await request(app).post(url).send({ code: 'c' });

    expect(res.status).toBe(409);
    expect(callsTo(userQueries.linkGoogleAccount)).toHaveLength(0);
  });

  it('refuses to guess between accounts that differ only by case', async () => {
    routeQueries(new Map([[userQueries.selectForGoogleSignIn, [
      buildUserRow({ email: 'PARENT.demo@example.com', google_sub: null }),
      buildUserRow({ email: 'parent.DEMO@example.com', google_sub: null }),
    ]]]));

    const res = await request(app).post(url).send({ code: 'c' });

    expect(res.status).toBe(409);
  });

  it('picks the exact-case account when several share the email', async () => {
    const exact = buildUserRow({ email: GOOGLE.email, google_sub: null });
    routeQueries(new Map([
      [userQueries.selectForGoogleSignIn, [buildUserRow({ email: 'PARENT.demo@example.com', google_sub: null }), exact]],
      [userQueries.linkGoogleAccount, [{ ...exact, google_sub: GOOGLE.sub }]],
    ]));

    const res = await request(app).post(url).send({ code: 'c' });

    expect(res.status).toBe(200);
    expect(res.body.data.userId).toBe(exact.user_id);
  });
});

describe('POST /api/auth/google: sign up', () => {
  const body = { code: 'c', intent: 'signup', school: 'ALHAADIACADEMY', role: 'PARENT' };

  it('creates a pending, email-verified account from the Google profile and tells the admins', async () => {
    routeQueries(new Map([
      [userQueries.selectForGoogleSignIn, []],
      [userQueries.createGoogleUser, (p) => [buildUserRow({
        user_id: p[0], email: p[1], username: p[2], password: p[3], first_name: p[4], last_name: p[5],
        school: p[6], role: p[7], google_sub: p[8], email_token: null, is_verified: true, is_verified_school: false,
      })]],
      [recipientsSql, [{ email: 'admin.demo@example.com' }]],
    ]));

    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(200);
    expect(callsTo(userQueries.createGoogleUser)[0][1]).toEqual([
      'mock-uuid-1234', GOOGLE.email, 'Demo Parent', '$2b$10$unusablehash', 'Demo', 'Parent', 'ALHAADIACADEMY', 'PARENT', GOOGLE.sub,
    ]);
    expect(res.body.message).toBe('Account created');
    expect(res.body.data).toMatchObject({
      accountCreated: true, role: 'PARENT', school: 'ALHAADIACADEMY', fullName: 'Demo Parent',
      isVerified: true, isVerifiedSchool: false,
    });
    const claims = jwt.verify(res.body.data.token, JWT_SECRET);
    expect(claims).toMatchObject({ isVerified: true, isVerifiedSchool: false });
    const subjects = mockSend.mock.calls.map(([msg]) => msg.subject);
    expect(subjects).toEqual(['Your Email Has Been Verified at School Mule', 'New User Awaiting School Approval']);
  });

  it('splits a single-field Google name', async () => {
    verifySignInCode.mockResolvedValue({ ...GOOGLE, givenName: '', familyName: '', name: 'Demo  Van Parent' });
    routeQueries(new Map([
      [userQueries.selectForGoogleSignIn, []],
      [userQueries.createGoogleUser, (p) => [buildUserRow({ user_id: p[0], first_name: p[4], last_name: p[5], is_verified_school: false })]],
    ]));

    await request(app).post(url).send(body);

    const params = callsTo(userQueries.createGoogleUser)[0][1];
    expect(params.slice(2, 6)).toEqual(['Demo Van Parent', '$2b$10$unusablehash', 'Demo', 'Van Parent']);
  });

  it('falls back to the email name when Google has no name at all', async () => {
    verifySignInCode.mockResolvedValue({ ...GOOGLE, givenName: '', familyName: '', name: '' });
    routeQueries(new Map([
      [userQueries.selectForGoogleSignIn, []],
      [userQueries.createGoogleUser, (p) => [buildUserRow({ user_id: p[0], first_name: p[4], last_name: p[5], is_verified_school: false })]],
    ]));

    await request(app).post(url).send(body);

    const params = callsTo(userQueries.createGoogleUser)[0][1];
    expect(params.slice(2, 6)).toEqual(['parent.demo', '$2b$10$unusablehash', 'parent.demo', '']);
  });

  it('signs an existing account in instead of creating a second one', async () => {
    const user = buildUserRow({ email: GOOGLE.email, role: 'TEACHER', google_sub: GOOGLE.sub });
    routeQueries(new Map([[userQueries.selectForGoogleSignIn, [user]]]));

    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(200);
    // Their real role, not the one the signup page asked for.
    expect(res.body.data).toMatchObject({ userId: user.user_id, role: 'TEACHER', accountCreated: false });
    expect(callsTo(userQueries.createGoogleUser)).toHaveLength(0);
  });

  it('409s when another signup for the address wins the race', async () => {
    routeQueries(new Map([
      [userQueries.selectForGoogleSignIn, []],
      [userQueries.createGoogleUser, Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'users_duplicate_email_key' })],
    ]));

    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already exists/);
  });

  it('400s on a school Postgres does not know', async () => {
    routeQueries(new Map([
      [userQueries.selectForGoogleSignIn, []],
      [userQueries.createGoogleUser, Object.assign(new Error('invalid input value for enum school'), { code: '22P02' })],
    ]));

    const res = await request(app).post(url).send({ ...body, school: 'NOSUCHSCHOOL' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/couldn't find that school/);
  });
});
