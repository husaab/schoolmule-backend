// Student sign-in (password and QR card), the student portal's /me, the
// teacher's reset / resend / QR-card actions, the admin's QR void and cards
// PDF, and admin "View as" a student. Synthetic identities only (@example.com).

const mockSend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: (...args) => mockSend(...args) } })),
}));

// Chromium is out of scope: capture the card sheet's HTML and the PDF options.
const mockPdf = { html: [], options: [] };
jest.mock('puppeteer', () => ({
  launch: jest.fn(async () => ({
    newPage: async () => ({
      setContent: async (html) => { mockPdf.html.push(html); },
      pdf: async (options) => { mockPdf.options.push(options); return Buffer.from('%PDF-1.4 student cards'); },
      close: async () => {},
    }),
    close: async () => {},
  })),
}));

// The sign-in limits count this file's deliberate failures per account; they
// have their own suite (signInLimits.routes.test.js).
jest.mock('../../../middleware/spamProtection', () => ({
  ...jest.requireActual('../../../middleware/spamProtection'),
  loginLimiter: (req, res, next) => next(),
  loginAccountLimiter: (req, res, next) => next(),
  qrCardLimiter: (req, res, next) => next(),
}));

// Google itself is out of scope: each test picks the identity the popup returns.
jest.mock('../../../services/google/googleSignIn', () => {
  const actual = jest.requireActual('../../../services/google/googleSignIn');
  return { ...actual, verifySignInCode: jest.fn() };
});

const request = require('supertest');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const { issueQrSecret, qrToken } = require('../../../services/classroom/studentLogin');
const { verifySignInCode } = require('../../../services/google/googleSignIn');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440004';
const AMAL_USER = '550e8400-e29b-41d4-a716-446655440010';
const SAMI_USER = '550e8400-e29b-41d4-a716-446655440011';

const PASSWORD = 'Correct-horse-battery-7';
const QR_INVALID_MESSAGE = "This card doesn't work any more. Ask your teacher for a new one.";

const asAdmin = { userId: ADMIN_ID, username: 'Office Admin', email: 'office@example.com', role: 'ADMIN' };
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'ziad.teacher@example.com', role: 'TEACHER' };
const asOtherTeacher = { userId: OTHER_TEACHER_ID, username: 'Rana Teacher', email: 'rana.teacher@example.com', role: 'TEACHER' };

// supertest leaves a PDF body empty unless asked to buffer it.
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('Integration: student sign-in', () => {
  let app, pool;
  let yearId, pastYearId, amalId, samiId, classA, classB;

  beforeAll(() => { app = getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role, password = 'hashed') => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, $4, $5, $6, 'ALHAADIACADEMY', $7, true, true)`,
    [id, email, `${first} ${last}`, password, first, last, role],
  );
  const student = (name, grade, year = yearId) => pool.query(
    `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id, student_email)
     VALUES ($1, $2, 'ALHAADIACADEMY', $3, $4, $5) RETURNING student_id`,
    [name, grade, year, TEACHER_ID, `${name.toLowerCase().replace(' ', '.')}@example.com`],
  ).then((r) => r.rows[0].student_id);
  // A student login with consent on file, linked to this year's row.
  const account = async (userId, studentId) => {
    await pool.query(
      `INSERT INTO student_accounts (user_id, school, consent_by, consent_at, consent_notice_version, created_by)
       VALUES ($1, 'ALHAADIACADEMY', $2, NOW(), '2026-10', $2)`, [userId, ADMIN_ID],
    );
    await pool.query(
      `INSERT INTO student_account_links (user_id, student_id, school_year_id, linked_by) VALUES ($1, $2, $3, $4)`,
      [userId, studentId, yearId, ADMIN_ID],
    );
  };
  const klass = (teacherId, teacherName, grade, subject) => pool.query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
     VALUES ('ALHAADIACADEMY', $1, $2, $3, $4, $5) RETURNING class_id`,
    [grade, subject, teacherName, teacherId, yearId],
  ).then((r) => r.rows[0].class_id);
  // A printed card: store the hash of a fresh secret, return the card's token.
  const issueCard = async (userId) => {
    const { secret, hash } = issueQrSecret();
    await pool.query(
      `UPDATE student_accounts SET qr_secret_hash = $2, qr_issued_at = NOW(), qr_voided_at = NULL WHERE user_id = $1`,
      [userId, hash],
    );
    return qrToken(userId, secret);
  };
  const qrState = async (userId) => (await pool.query(
    `SELECT qr_secret_hash, qr_issued_at, qr_voided_at FROM student_accounts WHERE user_id = $1`, [userId],
  )).rows[0];
  const setClassrooms = (enabled) => pool.query(
    `UPDATE school_classroom_settings SET enabled = $1 WHERE school = 'ALHAADIACADEMY'`, [enabled],
  );

  const login = (email, password = PASSWORD) => request(app).post('/api/auth/login').send({ email, password });
  const qrLogin = (token) => request(app).post('/api/auth/student-qr').send({ token });
  const withToken = (method, url, token) => request(app)[method](url).set('Authorization', `Bearer ${token}`);
  const studentToken = async (email = 'amal.haddad@example.com') => {
    const res = await login(email);
    expect(res.status).toBe(200);
    return res.body.data.token;
  };
  const pdfPost = (url, payload, body) => authenticatedRequest('post', url, payload).send(body).buffer(true).parse(binary);

  beforeEach(async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: 'email-1' } });
    mockPdf.html.length = 0;
    mockPdf.options.length = 0;

    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    pastYearId = (await pool.query(
      `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
       SELECT 'ALHAADIACADEMY', school_id, '2024-2025', DATE '2024-09-01', DATE '2025-06-30', FALSE
         FROM schools WHERE school_code = 'ALHAADIACADEMY'
       RETURNING school_year_id`,
    )).rows[0].school_year_id;

    const hash = await bcrypt.hash(PASSWORD, 4);
    await user(ADMIN_ID, 'office@example.com', 'Office', 'Admin', 'ADMIN');
    await user(TEACHER_ID, 'ziad.teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(OTHER_TEACHER_ID, 'rana.teacher@example.com', 'Rana', 'Teacher', 'TEACHER');
    await user(AMAL_USER, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT', hash);
    await user(SAMI_USER, 'sami.haddad@example.com', 'Sami', 'Haddad', 'STUDENT', hash);

    amalId = await student('Amal Haddad', '2');
    samiId = await student('Sami Haddad', '5');
    await account(AMAL_USER, amalId);
    await account(SAMI_USER, samiId);
    await pool.query(`INSERT INTO school_classroom_settings (school, enabled) VALUES ('ALHAADIACADEMY', TRUE)`);

    classA = await klass(TEACHER_ID, 'Ziad Teacher', '2', 'Math');
    classB = await klass(OTHER_TEACHER_ID, 'Rana Teacher', '5', 'Science');
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2), ($3, $4)`, [classA, amalId, classB, samiId]);
  });

  // 1
  it('password login as an active student returns role STUDENT and a token that expires within 12 hours', async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await login('amal.haddad@example.com');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      userId: AMAL_USER, role: 'STUDENT', baseRole: 'STUDENT', roles: ['STUDENT'], school: 'ALHAADIACADEMY',
    });
    const decoded = jwt.verify(res.body.data.token, process.env.JWT_SECRET);
    expect(decoded).toMatchObject({ userId: AMAL_USER, role: 'STUDENT', baseRole: 'STUDENT', roles: ['STUDENT'] });
    expect(decoded.exp - decoded.iat).toBe(12 * 60 * 60);
    expect(decoded.exp).toBeLessThanOrEqual(before + 12 * 60 * 60 + 5);
  });

  it('a student who types capitals (and spaces) can sign in', async () => {
    const res = await login('  Amal.Haddad@Example.COM ');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ userId: AMAL_USER, role: 'STUDENT', email: 'amal.haddad@example.com' });
  });

  // 2
  it('login is 403 CLASSROOM_DISABLED when the school has not turned classrooms on', async () => {
    await setClassrooms(false);
    const res = await login('amal.haddad@example.com');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      success: false, code: 'CLASSROOM_DISABLED', message: "Student sign-in isn't turned on at your school yet.",
    });
    expect(res.body.data).toBeNull();

    // No settings row at all reads as "off" too.
    await pool.query(`DELETE FROM school_classroom_settings`);
    expect((await login('amal.haddad@example.com')).body.code).toBe('CLASSROOM_DISABLED');
  });

  // 3
  it('login is 403 NO_STUDENT_LINK when the only link is to a past year', async () => {
    const pastRow = await student('Amal Haddad', '1', pastYearId);
    await pool.query(
      `UPDATE student_account_links SET student_id = $2, school_year_id = $3 WHERE user_id = $1`,
      [AMAL_USER, pastRow, pastYearId],
    );

    const res = await login('amal.haddad@example.com');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'NO_STUDENT_LINK', message: "Your account isn't set up for this school year yet. Ask your teacher.",
    });
  });

  it('login is 403 CONSENT_REQUIRED without consent and GRADE_NOT_ENABLED below the login grade', async () => {
    await pool.query(`UPDATE student_accounts SET consent_at = NULL WHERE user_id = $1`, [AMAL_USER]);
    expect((await login('amal.haddad@example.com')).body.code).toBe('CONSENT_REQUIRED');

    await pool.query(`UPDATE school_classroom_settings SET login_from_grade = '3'`);
    const res = await login('sami.haddad@example.com');
    expect(res.status).toBe(200);
    await pool.query(`UPDATE student_accounts SET consent_at = NOW() WHERE user_id = $1`, [AMAL_USER]);
    const blocked = await login('amal.haddad@example.com');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('GRADE_NOT_ENABLED');
  });

  it('Google sign-in applies the same student gate and forwards its code', async () => {
    verifySignInCode.mockResolvedValue({
      sub: 'google-sub-amal', email: 'amal.haddad@example.com', emailVerified: true,
      givenName: 'Amal', familyName: 'Haddad', name: 'Amal Haddad',
    });
    const google = () => request(app).post('/api/auth/google').send({ code: 'popup-code', intent: 'login' });

    const ok = await google();
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ userId: AMAL_USER, role: 'STUDENT' });
    const decoded = jwt.verify(ok.body.data.token, process.env.JWT_SECRET);
    expect(decoded.exp - decoded.iat).toBe(12 * 60 * 60);

    await setClassrooms(false);
    const blocked = await google();
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ success: false, code: 'CLASSROOM_DISABLED' });
  });

  // 4
  it('QR login works for grade 2 and is 401 QR_INVALID after the admin voids the card', async () => {
    const token = await issueCard(AMAL_USER);

    const ok = await qrLogin(token);
    expect(ok.status).toBe(200);
    expect(ok.body.message).toBe('Signed in');
    expect(ok.body.data).toMatchObject({ userId: AMAL_USER, role: 'STUDENT', email: 'amal.haddad@example.com' });
    const decoded = jwt.verify(ok.body.data.token, process.env.JWT_SECRET);
    expect(decoded.exp - decoded.iat).toBe(12 * 60 * 60);

    const voided = await authenticatedRequest('post', '/api/admin/student-accounts/qr/void', asAdmin)
      .send({ studentIds: [amalId, samiId] });
    expect(voided.status).toBe(200);
    expect(voided.body).toEqual({ status: 'success', data: { voided: 1 } });
    expect((await qrState(AMAL_USER)).qr_voided_at).toBeInstanceOf(Date);

    const dead = await qrLogin(token);
    expect(dead.status).toBe(401);
    expect(dead.body).toMatchObject({ success: false, code: 'QR_INVALID', message: QR_INVALID_MESSAGE });
  });

  it('a session from a QR card ends once that card is voided or reprinted; a password session does not (T3 M1)', async () => {
    const card = await issueCard(AMAL_USER);
    const fromCard = (await qrLogin(card)).body.data.token;
    const byPassword = await studentToken();
    expect((await withToken('get', '/api/student/me', fromCard)).status).toBe(200);
    expect((await withToken('get', '/api/auth/me', fromCard)).status).toBe(200);

    // Voided: the card's session is over at the portal and at /me (the client signs out).
    await authenticatedRequest('post', '/api/admin/student-accounts/qr/void', asAdmin).send({ studentIds: [amalId] });
    const portal = await withToken('get', '/api/student/me', fromCard);
    expect(portal.status).toBe(401);
    expect(portal.body).toMatchObject({ code: 'QR_INVALID', message: QR_INVALID_MESSAGE });
    const me = await withToken('get', '/api/auth/me', fromCard);
    expect(me.status).toBe(401);
    expect(me.body).toMatchObject({ success: false, code: 'QR_INVALID' });
    // Signing in with the password is a different session: it carries on.
    expect((await withToken('get', '/api/student/me', byPassword)).status).toBe(200);
    // Its own profile too (re-review N4): the voided card's session can't change the avatar or photo.
    const avatar = await withToken('put', '/api/profile/avatar', fromCard).send({ avatar: { style: 'long', skin: 1, bg: 2 } });
    expect(avatar.status).toBe(401);
    expect(avatar.body).toMatchObject({ code: 'QR_INVALID' });
    expect((await withToken('get', '/api/profile', fromCard)).status).toBe(401);
    expect((await withToken('delete', '/api/profile/photo', fromCard)).status).toBe(401);
    expect((await pool.query(`SELECT avatar FROM users WHERE user_id = $1`, [AMAL_USER])).rows[0].avatar).toBeNull();
    expect((await withToken('put', '/api/profile/avatar', byPassword).send({ avatar: { style: 'long', skin: 1, bg: 2 } })).status).toBe(200);

    // A new card: its session works; reprinting replaces the card and ends that session too.
    const second = await issueCard(AMAL_USER);
    const fromSecond = (await qrLogin(second)).body.data.token;
    expect((await withToken('get', '/api/student/me', fromSecond)).status).toBe(200);
    expect((await withToken('get', '/api/student/me', fromCard)).status).toBe(401); // the voided card stays over
    await issueCard(AMAL_USER);
    expect((await withToken('get', '/api/student/me', fromSecond)).status).toBe(401);
    expect((await withToken('get', '/api/student/me', byPassword)).status).toBe(200);
  });

  it("printed cards encode the plain-text payload 'SCHOOLMULE-QR:<token>' (no URL), and that payload signs the student in", async () => {
    const QRCode = require('qrcode');
    const spy = jest.spyOn(QRCode, 'toDataURL');
    try {
      const res = await pdfPost('/api/admin/student-accounts/cards.pdf', asAdmin, { studentIds: [amalId] });
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      const payload = spy.mock.calls[0][0];
      expect(payload).toMatch(new RegExp(`^SCHOOLMULE-QR:${AMAL_USER}\\.[A-Za-z0-9_-]{43}$`));
      expect(payload).not.toMatch(/https?:|\/qr\?/);
      // The scanner posts what it read; the bare token works as before.
      const scanned = await qrLogin(payload);
      expect(scanned.status).toBe(200);
      expect(scanned.body.data).toMatchObject({ userId: AMAL_USER, role: 'STUDENT' });
      expect((await qrLogin(payload.slice('SCHOOLMULE-QR:'.length))).status).toBe(200);
      expect((await qrLogin(`  ${payload}\n`)).status).toBe(200);
      expect((await qrLogin(`schoolmule-qr:${payload.slice(14)}`)).status).toBe(200);
      expect((await qrLogin(`SCHOOLMULE-QR:SCHOOLMULE-QR:${payload.slice(14)}`)).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  it('QR login is 401 QR_INVALID for a forged secret, garbage, and a staff user id', async () => {
    await issueCard(AMAL_USER);
    const forged = qrToken(AMAL_USER, issueQrSecret().secret);
    for (const token of [forged, 'not-a-card', '', qrToken(TEACHER_ID, issueQrSecret().secret)]) {
      const res = await qrLogin(token);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('QR_INVALID');
    }
    expect((await qrLogin(undefined)).status).toBe(401);
  });

  // 5
  it('QR login is 403 QR_NOT_ENABLED for grade 5', async () => {
    const token = await issueCard(SAMI_USER);
    const res = await qrLogin(token);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'QR_NOT_ENABLED', message: 'Sign in with your email and password.' });
  });

  // 6
  it('GET /api/student/me with the student token returns the linked student; with a teacher token 403', async () => {
    const token = await studentToken();

    const res = await withToken('get', '/api/student/me', token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'success',
      data: {
        student: { studentId: amalId, name: 'Amal Haddad', firstName: 'Amal', grade: '2', avatar: null },
        user: { userId: AMAL_USER, email: 'amal.haddad@example.com', avatar: null, photoUrl: null },
        school: { code: 'ALHAADIACADEMY', name: 'Al Haadi Academy' },
        settings: { studentPhotos: false },
        schoolYear: { schoolYearId: yearId, label: '2025-2026' },
      },
    });

    // student.avatar is the one Home shows: the teacher-set avatar until the student picks their own.
    const teacherSet = { style: 'long', skin: 0, bg: 7 };
    await pool.query(`UPDATE students SET avatar = $2::jsonb WHERE student_id = $1`, [amalId, JSON.stringify(teacherSet)]);
    expect((await withToken('get', '/api/student/me', token)).body.data.student.avatar).toEqual(teacherSet);
    await pool.query(`UPDATE users SET avatar = $2::jsonb WHERE user_id = $1`, [AMAL_USER, JSON.stringify({ style: 'beard', skin: 1, bg: 1 })]);
    const me = (await withToken('get', '/api/student/me', token)).body.data;
    expect(me.student.avatar).toEqual({ style: 'beard', skin: 1, bg: 1 });
    expect(me.student.avatar).toEqual((await withToken('get', '/api/student/home', token)).body.data.student.avatar);

    const teacher = await authenticatedRequest('get', '/api/student/me', asTeacher);
    expect(teacher.status).toBe(403);

    // The fence still holds for the same token everywhere else.
    const staffRoute = await withToken('get', '/api/classes', token);
    expect(staffRoute.status).toBe(403);
    expect(staffRoute.body.code).toBe('STUDENT_FORBIDDEN');
  });

  it("requireStudent resolves the request year's row: a past year without a link is 403 NO_STUDENT_LINK", async () => {
    const token = await studentToken();
    const res = await withToken('get', '/api/student/me', token).set('X-School-Year', pastYearId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_STUDENT_LINK');
  });

  it('an archived student token stops working at /api/student and /api/auth/me', async () => {
    const token = await studentToken();
    await pool.query(`UPDATE users SET is_archived = true WHERE user_id = $1`, [AMAL_USER]);
    expect((await withToken('get', '/api/student/me', token)).status).toBe(401);
    expect((await withToken('get', '/api/auth/me', token)).status).toBe(401);
  });

  // 7
  it('GET /api/auth/me for a student whose school turned classrooms off is 401 with code CLASSROOM_DISABLED', async () => {
    const token = await studentToken();
    const live = await withToken('get', '/api/auth/me', token);
    expect(live.status).toBe(200);
    expect(live.body.data).toMatchObject({ role: 'STUDENT', userId: AMAL_USER });

    await setClassrooms(false);
    const res = await withToken('get', '/api/auth/me', token);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, code: 'CLASSROOM_DISABLED' });

    // The portal itself refuses the open session too.
    const portal = await withToken('get', '/api/student/me', token);
    expect(portal.status).toBe(403);
    expect(portal.body.code).toBe('CLASSROOM_DISABLED');
  });

  it('Fable M6: an open session ends at the next /api/student call once consent is withdrawn or the sign-in grade is raised', async () => {
    const token = await studentToken();
    expect((await withToken('get', '/api/student/home', token)).status).toBe(200);

    // The admin raises the sign-in grade above Amal's (Grade 2).
    await pool.query(`UPDATE school_classroom_settings SET login_from_grade = '3' WHERE school = 'ALHAADIACADEMY'`);
    let res = await withToken('get', '/api/student/home', token);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ status: 'failed', code: 'GRADE_NOT_ENABLED', message: "Your grade doesn't use student sign-in yet." });
    expect((await withToken('get', '/api/auth/me', token)).body.code).toBe('GRADE_NOT_ENABLED');
    await pool.query(`UPDATE school_classroom_settings SET login_from_grade = '1' WHERE school = 'ALHAADIACADEMY'`);
    expect((await withToken('get', '/api/student/home', token)).status).toBe(200);

    // Consent withdrawn.
    await pool.query(`UPDATE student_accounts SET consent_at = NULL WHERE user_id = $1`, [AMAL_USER]);
    res = await withToken('get', '/api/student/me', token);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('CONSENT_REQUIRED');
  });

  // 8
  it("teacher of the class can reset a student's password (email queued via mocked resend); a teacher of another class gets 403", async () => {
    const url = `/api/classroom/classes/${classA}/students/${amalId}/reset-password`;
    const res = await authenticatedRequest('post', url, asTeacher);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'success', data: { sent: true } });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const payload = mockSend.mock.calls[0][0];
    expect(payload.to).toBe('amal.haddad@example.com');
    expect(payload.subject).toBe('Reset your SchoolMule password');
    expect(payload.html).toContain('Ziad Teacher asked for a new password link');
    const { rows: tokens } = await pool.query(`SELECT token FROM password_reset_tokens WHERE user_id = $1`, [AMAL_USER]);
    expect(tokens).toHaveLength(1);
    expect(payload.html).toContain(`/reset-password?token=${tokens[0].token}&amp;next=%2Fstudent`);

    // Not this teacher's class.
    const otherClass = await authenticatedRequest('post', url, asOtherTeacher);
    expect(otherClass.status).toBe(403);
    // Their own class, but the student isn't in it.
    const notEnrolled = await authenticatedRequest(
      'post', `/api/classroom/classes/${classB}/students/${amalId}/reset-password`, asOtherTeacher,
    );
    expect(notEnrolled.status).toBe(403);
    expect(mockSend).toHaveBeenCalledTimes(1);

    // Parents and students never reach the classroom API.
    const parent = await authenticatedRequest('post', url, { userId: ADMIN_ID, role: 'PARENT' });
    expect(parent.status).toBe(403);
  });

  it('teacher can resend the invite to an invited student; an active student gets a password link instead', async () => {
    const active = await authenticatedRequest(
      'post', `/api/classroom/classes/${classA}/students/${amalId}/resend-invite`, asTeacher,
    );
    expect(active.status).toBe(400);

    await pool.query(`UPDATE users SET password = '!' WHERE user_id = $1`, [AMAL_USER]);
    const res = await authenticatedRequest(
      'post', `/api/classroom/classes/${classA}/students/${amalId}/resend-invite`, asTeacher,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'success', data: { sent: true } });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatchObject({
      to: 'amal.haddad@example.com', subject: 'Set up your Al Haadi Academy SchoolMule account',
    });
    // The teacher's resend is a real invite, recorded with the teacher as its sender.
    const { rows: invites } = await pool.query(`SELECT created_by, end_reason FROM student_invites WHERE user_id = $1`, [AMAL_USER]);
    expect(invites).toEqual([{ created_by: TEACHER_ID, end_reason: null }]);
  });

  // 9
  it('cards.pdf returns application/pdf and replaces the stored hash (old token stops working)', async () => {
    const oldToken = await issueCard(AMAL_USER);
    const oldHash = (await qrState(AMAL_USER)).qr_secret_hash;
    expect((await qrLogin(oldToken)).status).toBe(200);

    const res = await pdfPost('/api/admin/student-accounts/cards.pdf', asAdmin, { studentIds: [amalId, samiId] });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename=".+\.pdf"$/);
    // Grade 5 is past qrUntilGrade '3': no card, and the caller is told.
    expect(res.headers['x-skipped-students']).toBe(samiId);
    expect(res.headers['x-skipped-count']).toBe('1');
    expect(res.body.toString()).toBe('%PDF-1.4 student cards');

    const now = await qrState(AMAL_USER);
    expect(now.qr_secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(now.qr_secret_hash).not.toBe(oldHash);
    expect(now.qr_voided_at).toBeNull();
    expect((await qrState(SAMI_USER)).qr_secret_hash).toBeNull();

    const dead = await qrLogin(oldToken);
    expect(dead.status).toBe(401);
    expect(dead.body.code).toBe('QR_INVALID');

    expect(mockPdf.options[0]).toMatchObject({ format: 'Letter', margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } });
    const html = mockPdf.html[0];
    expect(html).toContain('Al Haadi Academy');
    expect(html).toContain('Amal Haddad');
    expect(html).toContain('Grade 2 · Ziad Teacher');
    expect(html).toContain('Scan to sign in');
    expect(html).toContain('Or sign in at localhost:3000 with amal.haddad@example.com');
    expect(html).toMatch(/<img[^>]+src="data:image\/png;base64,/);
    expect(html).not.toContain('Sami Haddad');
  });

  it('cards.pdf is 404 when no card could be issued and 400 for a bad body', async () => {
    const none = await authenticatedRequest('post', '/api/admin/student-accounts/cards.pdf', asAdmin)
      .send({ studentIds: [samiId] });
    expect(none.status).toBe(404);
    expect(none.body.status).toBe('failed');

    const bad = await authenticatedRequest('post', '/api/admin/student-accounts/cards.pdf', asAdmin)
      .send({ studentIds: ['nope'] });
    expect(bad.status).toBe(400);

    const teacher = await authenticatedRequest('post', '/api/admin/student-accounts/cards.pdf', asTeacher)
      .send({ studentIds: [amalId] });
    expect(teacher.status).toBe(403);
  });

  it("the teacher's QR cards cover only students enrolled in the class", async () => {
    const res = await pdfPost(`/api/classroom/classes/${classA}/qr-cards.pdf`, asTeacher, { studentIds: [amalId] });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-skipped-students']).toBeUndefined();
    expect((await qrState(AMAL_USER)).qr_secret_hash).toMatch(/^[0-9a-f]{64}$/);

    const outsider = await authenticatedRequest('post', `/api/classroom/classes/${classA}/qr-cards.pdf`, asTeacher)
      .send({ studentIds: [amalId, samiId] });
    expect(outsider.status).toBe(403);
    expect((await qrState(SAMI_USER)).qr_secret_hash).toBeNull();

    const otherClass = await authenticatedRequest('post', `/api/classroom/classes/${classA}/qr-cards.pdf`, asOtherTeacher)
      .send({ studentIds: [amalId] });
    expect(otherClass.status).toBe(403);

    // A past year's class never mints a card, even for a student it still lists.
    const hashNow = (await qrState(AMAL_USER)).qr_secret_hash;
    const pastRow = await student('Amal Haddad', '1', pastYearId);
    const { rows: [past] } = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
       VALUES ('ALHAADIACADEMY', '1', 'Math', 'Rana Teacher', $1, $2) RETURNING class_id`,
      [OTHER_TEACHER_ID, pastYearId],
    );
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [past.class_id, pastRow]);
    const pastYear = await authenticatedRequest('post', `/api/classroom/classes/${past.class_id}/qr-cards.pdf`, asOtherTeacher)
      .send({ studentIds: [pastRow] });
    expect(pastYear.status).toBe(404);
    expect((await qrState(AMAL_USER)).qr_secret_hash).toBe(hashNow);
  });

  // 10
  it('admin can View-as an active student; the token has role STUDENT and impersonator; POST /api/student/... with it is 403 IMPERSONATION_READ_ONLY', async () => {
    const res = await authenticatedRequest('post', `/api/admin/users/${AMAL_USER}/impersonate`, asAdmin);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ userId: AMAL_USER, role: 'STUDENT', roles: ['STUDENT'] });
    const decoded = jwt.verify(res.body.data.token, process.env.JWT_SECRET);
    expect(decoded).toMatchObject({ userId: AMAL_USER, role: 'STUDENT', baseRole: 'STUDENT' });
    expect(decoded.impersonator).toMatchObject({ userId: ADMIN_ID });

    const read = await withToken('get', '/api/student/me', res.body.data.token);
    expect(read.status).toBe(200);
    expect(read.body.data.student.studentId).toBe(amalId);

    const me = await withToken('get', '/api/auth/me', res.body.data.token);
    expect(me.status).toBe(200);
    expect(me.body.data.impersonator).toMatchObject({ userId: ADMIN_ID });

    const write = await withToken('post', '/api/student/me', res.body.data.token).send({});
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('IMPERSONATION_READ_ONLY');

    // The fence applies to the preview token as well.
    const staff = await withToken('get', '/api/classes', res.body.data.token);
    expect(staff.body.code).toBe('STUDENT_FORBIDDEN');
  });

  it("View-as refuses a student account that isn't linked to this school year (409)", async () => {
    await pool.query(`DELETE FROM student_account_links WHERE user_id = $1`, [SAMI_USER]);
    const res = await authenticatedRequest('post', `/api/admin/users/${SAMI_USER}/impersonate`, asAdmin);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe("This student account isn't linked to this school year.");
  });
});
