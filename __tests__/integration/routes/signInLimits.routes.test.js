// Sign-in rate limits against the real app (middleware/spamProtection.js):
// a whole class signs in from one school network, so successes never count
// and failures are limited per account and per network. Every test uses its
// own X-Forwarded-For address (the app trusts one proxy hop), since the
// limiters' counters live for the whole file. Synthetic identities only.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const request = require('supertest');
const bcrypt = require('bcrypt');
const { getApp } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const { issueQrSecret, qrToken } = require('../../../services/classroom/studentLogin');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const PASSWORD = 'Class-password-42';
const CLASS_SIZE = 25;

const pad = (n) => String(n).padStart(2, '0');
const learnerId = (n) => `550e8400-e29b-41d4-a716-4466554401${pad(n)}`;
const learnerEmail = (n) => `learner${pad(n)}@example.com`;

describe('Integration: sign-in rate limits', () => {
  let app, pool, yearId, passwordHash;
  const cards = new Map(); // learner number → QR token

  beforeAll(async () => {
    app = getApp();
    pool = getTestPool();
    passwordHash = await bcrypt.hash(PASSWORD, 4);
  });

  // A Grade 2 class of CLASS_SIZE students, every one able to sign in with a
  // password or a QR card.
  beforeEach(async () => {
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, 'office@example.com', 'Office Admin', 'hashed', 'Office', 'Admin', 'ALHAADIACADEMY', 'ADMIN', true, true)`,
      [ADMIN_ID],
    );
    await pool.query(`INSERT INTO school_classroom_settings (school, enabled) VALUES ('ALHAADIACADEMY', TRUE)`);

    cards.clear();
    for (let n = 1; n <= CLASS_SIZE; n += 1) {
      const userId = learnerId(n);
      const { secret, hash } = issueQrSecret();
      await pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ($1, $2, $3, $4, 'Learner', $5, 'ALHAADIACADEMY', 'STUDENT', true, true)`,
        [userId, learnerEmail(n), `Learner ${pad(n)}`, passwordHash, pad(n)],
      );
      const { rows: [row] } = await pool.query(
        `INSERT INTO students (name, grade, school, school_year_id, student_email)
         VALUES ($1, '2', 'ALHAADIACADEMY', $2, $3) RETURNING student_id`,
        [`Learner ${pad(n)}`, yearId, learnerEmail(n)],
      );
      await pool.query(
        `INSERT INTO student_accounts (user_id, school, consent_by, consent_at, consent_notice_version, created_by, qr_secret_hash, qr_issued_at)
         VALUES ($1, 'ALHAADIACADEMY', $2, NOW(), '2026-10', $2, $3, NOW())`,
        [userId, ADMIN_ID, hash],
      );
      await pool.query(
        `INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`,
        [userId, row.student_id, yearId],
      );
      cards.set(n, qrToken(userId, secret));
    }
  });

  const from = (ip) => ({
    login: (email, password = PASSWORD) =>
      request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email, password }),
    qr: (token) => request(app).post('/api/auth/student-qr').set('X-Forwarded-For', ip).send({ token }),
  });

  it(`${CLASS_SIZE} students signing in with passwords from one school network all get in`, async () => {
    const school = from('203.0.113.10');
    for (let n = 1; n <= CLASS_SIZE; n += 1) {
      const res = await school.login(learnerEmail(n));
      expect(res.status).toBe(200);
      expect(res.body.data.userId).toBe(learnerId(n));
    }
  });

  it(`${CLASS_SIZE} students scanning QR cards from one school network all get in`, async () => {
    const school = from('203.0.113.11');
    for (let n = 1; n <= CLASS_SIZE; n += 1) {
      const res = await school.qr(cards.get(n));
      expect(res.status).toBe(200);
      expect(res.body.data.userId).toBe(learnerId(n));
    }
    // And again (a second lesson): successes never use up the budget.
    for (let n = 1; n <= CLASS_SIZE; n += 1) expect((await school.qr(cards.get(n))).status).toBe(200);
  });

  it('repeated wrong passwords on one account are limited after 10, without locking out classmates', async () => {
    const school = from('203.0.113.12');
    for (let i = 0; i < 10; i += 1) {
      expect((await school.login(learnerEmail(1), `wrong-${i}`)).status).toBe(401);
    }
    // The address in any case or spacing is the same account.
    const limited = await school.login(` LEARNER01@Example.com `, 'wrong-again');
    expect(limited.status).toBe(429);
    expect(limited.body.message).toBe('Too many login attempts. Please try again later.');
    // Even the right password waits out the window on that network...
    expect((await school.login(learnerEmail(1))).status).toBe(429);
    // ...while classmates on the same network still get in.
    expect((await school.login(learnerEmail(2))).status).toBe(200);
  });

  it('repeated forged secrets on one QR card are limited after 10, without locking out classmates', async () => {
    const school = from('203.0.113.13');
    for (let i = 0; i < 10; i += 1) {
      const res = await school.qr(qrToken(learnerId(1), issueQrSecret().secret));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('QR_INVALID');
    }
    expect((await school.qr(qrToken(learnerId(1), issueQrSecret().secret))).status).toBe(429);
    expect((await school.qr(cards.get(1))).status).toBe(429);
    expect((await school.qr(cards.get(2))).status).toBe(200);
  });

  it('a network that fails 100 sign-ins across many accounts is limited', async () => {
    const sprayer = from('203.0.113.14');
    for (let i = 0; i < 100; i += 1) {
      expect((await sprayer.login(`nobody${i}@example.com`, 'guess')).status).toBe(404);
    }
    expect((await sprayer.login('nobody-else@example.com', 'guess')).status).toBe(429);
    expect((await sprayer.qr(cards.get(3))).status).toBe(429);
    // Another network is unaffected.
    expect((await from('203.0.113.15').login(learnerEmail(3))).status).toBe(200);
  });
});
