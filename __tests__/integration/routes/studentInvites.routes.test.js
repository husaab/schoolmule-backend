// Student invitations: the invite record, its one-time link, resend, cancel,
// preview and next-year links (admin side), and accepting it (student side).
// Synthetic identities only: every address is @example.com.

const mockSend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: (...args) => mockSend(...args) } })),
}));

jest.mock('../../../services/google/googleSignIn', () => {
  const actual = jest.requireActual('../../../services/google/googleSignIn');
  return { ...actual, verifySignInCode: jest.fn() };
});

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const { hashInviteSecret } = require('../../../services/classroom/studentInvites');
const { verifySignInCode } = require('../../../services/google/googleSignIn');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const MOTHER_ID = '550e8400-e29b-41d4-a716-446655440002';

const asAdmin = { userId: ADMIN_ID, username: 'Office Admin', email: 'office@example.com', role: 'ADMIN' };
const BASE = '/api/admin/student-accounts';

// The secret in an invite email's link (/student-invite#<secret>).
const secretIn = (html) => {
  const m = /\/student-invite#([A-Za-z0-9_-]{43})/.exec(html);
  return m ? m[1] : null;
};

describe('Integration: Student invitations', () => {
  let pool;
  let yearId, amalId, samiId, ramiId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, 'ALHAADIACADEMY', $6, true, true)`,
    [id, email, `${first} ${last}`, first, last, role],
  );
  const student = (name, grade, extra = {}) => pool.query(
    `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id, student_email, mother_email, previous_student_id)
     VALUES ($1, $2, 'ALHAADIACADEMY', $3, $4, $5, $6, $7) RETURNING student_id`,
    [name, grade, extra.yearId ?? yearId, TEACHER_ID, extra.studentEmail ?? null, extra.motherEmail ?? null, extra.previousId ?? null],
  ).then((r) => r.rows[0].student_id);
  const invite = (studentIds, headers = {}) => {
    const req = authenticatedRequest('post', `${BASE}/invite`, asAdmin);
    Object.entries(headers).forEach(([k, v]) => req.set(k, v));
    return req.send({ studentIds, consentConfirmed: true });
  };
  const loginOf = async (studentId) => (await pool.query(
    `SELECT u.* FROM student_account_links l JOIN users u ON u.user_id = l.user_id WHERE l.student_id = $1`, [studentId],
  )).rows[0];
  const invitesOf = async (studentId) => (await pool.query(
    `SELECT * FROM student_invites WHERE student_id = $1 ORDER BY created_at`, [studentId],
  )).rows;
  const list = async () => (await authenticatedRequest('get', BASE, asAdmin)).body.data;
  const rowOf = (data, id) => data.students.find((s) => s.studentId === id);
  const nextYear = () => pool.query(
    `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
     SELECT school, school_id, '2026-2027', '2026-09-01', '2027-06-30', false FROM school_years WHERE school_year_id = $1
     RETURNING school_year_id`, [yearId],
  ).then((r) => r.rows[0].school_year_id);

  beforeEach(async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: 'email-1' } });
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    await user(ADMIN_ID, 'office@example.com', 'Office', 'Admin', 'ADMIN');
    await user(TEACHER_ID, 'teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(MOTHER_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    amalId = await student('Amal Haddad', '5', { studentEmail: 'amal.haddad@example.com', motherEmail: 'mona.haddad@example.com' });
    samiId = await student('Sami Haddad', '2', { studentEmail: 'sami.haddad@example.com' });
    ramiId = await student('Rami Omar', '6', { studentEmail: 'rami.omar@example.com' });
    await pool.query(`INSERT INTO school_classroom_settings (school, enabled) VALUES ('ALHAADIACADEMY', TRUE)`);
  });

  describe('admin side', () => {
    it('invite stores one row with only the hash, a 14-day expiry, the send outcome and the address; the email links to /student-invite#<secret>', async () => {
      const res = await invite([amalId]);
      expect(res.status).toBe(200);
      expect(res.body.data.results[0]).toMatchObject({ outcome: 'invited', inviteSent: true, sendStatus: 'sent', inviteId: expect.any(String) });

      const [row] = await invitesOf(amalId);
      const login = await loginOf(amalId);
      expect(row).toMatchObject({
        school: 'ALHAADIACADEMY', user_id: login.user_id, school_year_id: yearId, email: 'amal.haddad@example.com',
        send_status: 'sent', provider_message_id: 'email-1', created_by: ADMIN_ID, ended_at: null, end_reason: null,
      });
      const days = (row.expires_at - row.created_at) / 86400000;
      expect(days).toBeGreaterThan(13.99);
      expect(days).toBeLessThan(14.01);

      const mail = mockSend.mock.calls[0][0];
      expect(mail).toMatchObject({ to: 'amal.haddad@example.com', subject: 'Set up your Al Haadi Academy SchoolMule account' });
      expect(mail.html).toContain('Set up my account');
      expect(mail.html).toContain('amal.haddad@example.com');
      expect(mail.html).toContain("If you aren't Amal Haddad, you can ignore this email.");
      const secret = secretIn(mail.html);
      expect(secret).toEqual(expect.any(String));
      expect(row.token_hash).toBe(hashInviteSecret(secret));
      // The secret itself is nowhere in the database, and no password-reset token is made.
      expect(JSON.stringify(row)).not.toContain(secret);
      expect((await pool.query(`SELECT 1 FROM password_reset_tokens WHERE user_id = $1`, [login.user_id])).rows).toHaveLength(0);
    });

    it('Grade 1–3 students get the invite email too (owner, D6)', async () => {
      await invite([samiId]);
      expect(mockSend.mock.calls[0][0].to).toBe('sami.haddad@example.com');
    });

    it('invite after rollover also links the already-rolled successor row', async () => {
      const next = await nextYear();
      const amalNext = await student('Amal Haddad', '6', { yearId: next, studentEmail: 'amal.haddad@example.com', previousId: amalId });
      await invite([amalId]);
      const login = await loginOf(amalId);
      const { rows } = await pool.query(
        `SELECT student_id, school_year_id FROM student_account_links WHERE user_id = $1 ORDER BY school_year_id = $2 DESC`,
        [login.user_id, yearId],
      );
      expect(rows).toEqual([
        { student_id: amalId, school_year_id: yearId },
        { student_id: amalNext, school_year_id: next },
      ]);
    });

    it('invite while viewing a non-active year answers 409 and creates nothing', async () => {
      const next = await nextYear();
      const amalNext = await student('Amal Haddad', '6', { yearId: next, studentEmail: 'amal.haddad@example.com', previousId: amalId });
      const res = await invite([amalNext], { 'X-School-Year': next });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe("Invites go to this school year's students. Switch to the current school year to invite.");
      expect((await pool.query(`SELECT 1 FROM users WHERE role::text = 'STUDENT'`)).rows).toHaveLength(0);
    });

    it('a failed send keeps the account, records the failure, and the row needs attention', async () => {
      mockSend.mockResolvedValue({ error: { message: 'Resend is down' } });
      const res = await invite([amalId]);
      expect(res.body.data.results[0]).toMatchObject({ outcome: 'invited', inviteSent: false, sendStatus: 'failed' });
      const [row] = await invitesOf(amalId);
      expect(row).toMatchObject({ send_status: 'failed', send_error: 'Resend is down', sent_at: null });
      expect(rowOf(await list(), amalId)).toMatchObject({
        status: 'invited', needsAttention: true, invite: { state: 'failed', error: 'Resend is down' },
      });
    });

    it('resend replaces the open invite and sends a new link; the old row reads replaced', async () => {
      await invite([amalId]);
      const firstSecret = secretIn(mockSend.mock.calls[0][0].html);
      const res = await authenticatedRequest('post', `${BASE}/${amalId}/resend-invite`, asAdmin);
      expect(res.status).toBe(200);
      const rows = await invitesOf(amalId);
      expect(rows.map((r) => [r.end_reason, r.ended_by])).toEqual([['replaced', ADMIN_ID], [null, null]]);
      const secondSecret = secretIn(mockSend.mock.calls[1][0].html);
      expect(secondSecret).not.toBe(firstSecret);
      expect(rows[1].token_hash).toBe(hashInviteSecret(secondSecret));
    });

    it('the bulk resend sends to each invited student and skips the rest', async () => {
      await invite([amalId, samiId]);
      mockSend.mockClear();
      const res = await authenticatedRequest('post', `${BASE}/invites/resend`, asAdmin).send({ studentIds: [amalId, samiId, ramiId] });
      expect(res.status).toBe(200);
      expect(res.body.data.results).toEqual([
        { studentId: amalId, outcome: 'sent', message: 'Invite sent again to amal.haddad@example.com' },
        { studentId: samiId, outcome: 'sent', message: 'Invite sent again to sami.haddad@example.com' },
        { studentId: ramiId, outcome: 'skipped', message: "This student doesn't have an account yet" },
      ]);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('a 6th invite email for one student within 24 hours answers 429', async () => {
      await invite([amalId]);
      for (let i = 0; i < 4; i += 1) {
        expect((await authenticatedRequest('post', `${BASE}/${amalId}/resend-invite`, asAdmin)).status).toBe(200);
      }
      const sixth = await authenticatedRequest('post', `${BASE}/${amalId}/resend-invite`, asAdmin);
      expect(sixth.status).toBe(429);
      expect(sixth.body.message).toBe('Too many invites for Amal today. Try again tomorrow.');
      expect(await invitesOf(amalId)).toHaveLength(5);
    });

    it('cancel on an unused login deletes it, keeps the invite row as cancelled, and the student is Not invited again', async () => {
      await invite([amalId]);
      const login = await loginOf(amalId);
      const res = await authenticatedRequest('post', `${BASE}/${amalId}/invite/cancel`, asAdmin);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ studentId: amalId, status: 'not_invited', account: null });
      expect((await pool.query(`SELECT 1 FROM users WHERE user_id = $1`, [login.user_id])).rows).toHaveLength(0);
      const [row] = await invitesOf(amalId);
      expect(row).toMatchObject({ user_id: null, end_reason: 'cancelled', ended_by: ADMIN_ID });
      // The address is free for a corrected invite.
      expect((await invite([amalId])).body.data.results[0].outcome).toBe('invited');
    });

    it('cancel on a login that has signed in with its card keeps the login', async () => {
      await invite([samiId]);
      const login = await loginOf(samiId);
      await pool.query(`UPDATE student_accounts SET activated_at = NOW(), activated_via = 'card' WHERE user_id = $1`, [login.user_id]);
      const res = await authenticatedRequest('post', `${BASE}/${samiId}/invite/cancel`, asAdmin);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'active', signInMethod: 'card', invite: { state: 'cancelled' } });
      expect((await pool.query(`SELECT 1 FROM users WHERE user_id = $1`, [login.user_id])).rows).toHaveLength(1);
      // Nothing left to cancel.
      expect((await authenticatedRequest('post', `${BASE}/${samiId}/invite/cancel`, asAdmin)).status).toBe(409);
    });

    it('archive and delete end the open invite', async () => {
      await invite([amalId, ramiId]);
      await authenticatedRequest('post', `${BASE}/${amalId}/archive`, asAdmin);
      expect((await invitesOf(amalId))[0].end_reason).toBe('archived');
      expect((await authenticatedRequest('delete', `${BASE}/${ramiId}/account`, asAdmin)).status).toBe(200);
      expect((await invitesOf(ramiId))[0]).toMatchObject({ user_id: null, end_reason: 'cancelled' });
    });

    it('the invite preview renders the real template with no real secret', async () => {
      const res = await authenticatedRequest('get', `${BASE}/invite-preview?studentId=${amalId}`, asAdmin);
      expect(res.status).toBe(200);
      expect(res.body.data.subject).toBe('Set up your Al Haadi Academy SchoolMule account');
      expect(res.body.data.html).toContain('Hi Amal,');
      expect(res.body.data.html).toContain('/student-invite#preview');
      expect(mockSend).not.toHaveBeenCalled();
      expect((await authenticatedRequest('get', `${BASE}/invite-preview?studentId=nope`, asAdmin)).status).toBe(404);
    });

    it('siblings saved with one address are both skipped, and neither gets a login (Review Focus 4)', async () => {
      await pool.query(`UPDATE students SET student_email = 'amal.haddad@example.com' WHERE student_id = $1`, [samiId]);
      const res = await invite([amalId, samiId]);
      expect(res.body.data).toMatchObject({ invited: 0, skipped: 2 });
      expect(res.body.data.results.map((r) => r.reason)).toEqual(['shared_with_student', 'shared_with_student']);
      expect((await pool.query(`SELECT 1 FROM users WHERE role::text = 'STUDENT'`)).rows).toHaveLength(0);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('student side', () => {
    let ip = 0;
    let addr;
    // Every test gets its own network address: the sign-in limiters count
    // failures per address for the whole file.
    beforeEach(() => { ip += 1; addr = `10.9.0.${ip}`; });
    const pub = (path) => request(getApp()).post(path).set('X-Forwarded-For', addr);
    const inspect = (token) => pub('/api/auth/student-invite').send({ token });
    const accept = (body) => pub('/api/auth/student-invite/accept').send(body);
    const invitedSecret = async (studentId) => {
      mockSend.mockClear();
      await invite([studentId]);
      return secretIn(mockSend.mock.calls[0][0].html);
    };
    const google = (overrides = {}) => ({
      sub: 'google-sub-amal', email: 'amal.haddad@example.com', emailVerified: true, hd: null,
      givenName: 'Amal', familyName: 'Haddad', name: 'Amal Haddad', ...overrides,
    });
    const me = (token) => request(getApp()).get('/api/student/me').set('Authorization', `Bearer ${token}`);

    beforeEach(async () => {
      // Amal's guardians: the mother's account (also her mother_email on file,
      // so one email) and the father's contact address without an account.
      await pool.query(
        `INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school)
         VALUES ($1, $2, 'Mona Haddad', 'mona.haddad@example.com', 'Mother', 'ALHAADIACADEMY'),
                ($1, NULL, 'Karim Haddad', 'Karim.Haddad@example.com', 'Father', 'ALHAADIACADEMY')`,
        [amalId, MOTHER_ID],
      );
    });

    it('inspect shows who the invite is for and the ways in, and inspecting changes nothing (Review Focus 3)', async () => {
      const secret = await invitedSecret(amalId);
      const first = await inspect(secret);
      expect(first.status).toBe(200);
      expect(first.body.data).toEqual({
        state: 'valid',
        school: { code: 'ALHAADIACADEMY', name: 'Al Haadi Academy' },
        student: { firstName: 'Amal', lastInitial: 'H', grade: '5' },
        email: 'amal.haddad@example.com',
        methods: { google: true, password: true },
        expiresAt: expect.any(String),
      });
      const [before] = await invitesOf(amalId);
      await inspect(secret);
      const [after] = await invitesOf(amalId);
      expect(after).toEqual(before);
    });

    it('accept with a password signs in to the SAME student row, ends the invite, and emails each guardian once', async () => {
      const secret = await invitedSecret(amalId);
      const login = await loginOf(amalId);
      await pool.query(`INSERT INTO password_reset_tokens (user_id, expires_at) VALUES ($1, NOW() + interval '1 day')`, [login.user_id]);
      const counts = async () => (await pool.query(
        `SELECT (SELECT COUNT(*) FROM students)::int AS students, (SELECT COUNT(*) FROM users)::int AS users`,
      )).rows[0];
      const before = await counts();
      mockSend.mockClear();

      const res = await accept({ token: secret, password: 'cedar-river' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ role: 'STUDENT', userId: login.user_id, token: expect.any(String) });
      expect(await counts()).toEqual(before);

      const mine = await me(res.body.data.token);
      expect(mine.status).toBe(200);
      expect(mine.body.data.student.studentId).toBe(amalId);

      const [row] = await invitesOf(amalId);
      expect(row).toMatchObject({ end_reason: 'accepted', accepted_via: 'password', ended_at: expect.any(Date) });
      expect((await pool.query(`SELECT 1 FROM password_reset_tokens WHERE user_id = $1`, [login.user_id])).rows).toHaveLength(0);
      const { rows: [acct] } = await pool.query(`SELECT * FROM student_accounts WHERE user_id = $1`, [login.user_id]);
      expect(acct).toMatchObject({ activated_via: 'password', activated_at: expect.any(Date), guardians_notified_at: expect.any(Date) });

      const sentTo = mockSend.mock.calls.map(([m]) => m.to).sort();
      expect(sentTo).toEqual(['karim.haddad@example.com', 'mona.haddad@example.com']);
      expect(mockSend.mock.calls[0][0].subject).toBe("Amal's SchoolMule account is ready");
      expect(mockSend.mock.calls[0][0].html).toContain('(set a password)');
      expect(rowOf(await list(), amalId)).toMatchObject({ status: 'active', signInMethod: 'password' });
    });

    it('a used link answers used, and of two accepts at once exactly one wins', async () => {
      const secret = await invitedSecret(amalId);
      const both = await Promise.all([
        accept({ token: secret, password: 'cedar-river' }),
        accept({ token: secret, password: 'maple-lake' }),
      ]);
      expect(both.map((r) => r.status).sort()).toEqual([200, 410]);
      const again = await accept({ token: secret, password: 'cedar-river' });
      expect(again.status).toBe(410);
      expect(again.body).toMatchObject({ code: 'INVITE_USED', data: { state: 'used' } });
      expect((await inspect(secret)).body.data.state).toBe('used');
    });

    it('an expired link answers expired', async () => {
      const secret = await invitedSecret(amalId);
      await pool.query(`UPDATE student_invites SET expires_at = NOW() - interval '1 second' WHERE student_id = $1`, [amalId]);
      expect((await inspect(secret)).body.data.state).toBe('expired');
      const res = await accept({ token: secret, password: 'cedar-river' });
      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ code: 'INVITE_EXPIRED', data: { state: 'expired' } });
    });

    it('after a resend the old link answers replaced; after a cancel, cancelled', async () => {
      const first = await invitedSecret(amalId);
      await authenticatedRequest('post', `${BASE}/${amalId}/resend-invite`, asAdmin);
      expect((await inspect(first)).body.data.state).toBe('replaced');
      expect((await accept({ token: first, password: 'cedar-river' })).status).toBe(410);

      const sami = await invitedSecret(samiId);
      await authenticatedRequest('post', `${BASE}/${samiId}/invite/cancel`, asAdmin);
      expect((await inspect(sami)).body.data.state).toBe('cancelled');
      expect((await accept({ token: sami, password: 'cedar-river' })).body.data.state).toBe('cancelled');
    });

    it('a garbled or unknown token answers 404, and 21 failures from one network answer 429', async () => {
      expect((await inspect('not-a-token')).status).toBe(404);
      expect((await inspect('x'.repeat(43))).body).toMatchObject({ code: 'INVITE_NOT_FOUND' });
      for (let i = 0; i < 18; i += 1) await inspect('y'.repeat(43));
      expect((await inspect('z'.repeat(43))).status).toBe(429);
    });

    it('a weak password is refused with the reason and nothing changes', async () => {
      const secret = await invitedSecret(amalId);
      const res = await accept({ token: secret, password: 'amalhaddad1' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'PASSWORD_WEAK', message: "Don't use your name in your password." });
      expect((await invitesOf(amalId))[0].ended_at).toBeNull();
    });

    it('Google with a different address is refused and changes nothing', async () => {
      const secret = await invitedSecret(amalId);
      verifySignInCode.mockResolvedValue(google({ email: 'mona.h@example.com' }));
      const res = await accept({ token: secret, googleCode: 'code' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'GOOGLE_WRONG_ACCOUNT',
        message: 'That Google account is mona.h@example.com. This invite is for amal.haddad@example.com.',
      });
      expect((await loginOf(amalId)).google_sub).toBeNull();
    });

    it('Google on a declared school domain must be that Workspace domain', async () => {
      await pool.query(`UPDATE school_classroom_settings SET student_email_domains = '{example.com}'`);
      const secret = await invitedSecret(amalId);
      verifySignInCode.mockResolvedValue(google({ hd: null }));
      const res = await accept({ token: secret, googleCode: 'code' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('GOOGLE_WRONG_DOMAIN');

      verifySignInCode.mockResolvedValue(google({ hd: 'example.com' }));
      const ok = await accept({ token: secret, googleCode: 'code' });
      expect(ok.status).toBe(200);
      expect((await loginOf(amalId)).google_sub).toBe('google-sub-amal');
      expect((await invitesOf(amalId))[0]).toMatchObject({ end_reason: 'accepted', accepted_via: 'google' });
    });

    it('a Google account already linked to someone else is refused', async () => {
      await pool.query(`UPDATE users SET google_sub = 'google-sub-amal' WHERE user_id = $1`, [MOTHER_ID]);
      const secret = await invitedSecret(amalId);
      verifySignInCode.mockResolvedValue(google());
      const res = await accept({ token: secret, googleCode: 'code' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('GOOGLE_IN_USE');
    });

    it('a Google-only school offers no password and refuses one', async () => {
      await pool.query(`UPDATE school_classroom_settings SET student_sign_in = 'google_only'`);
      const secret = await invitedSecret(amalId);
      expect(mockSend.mock.calls[0][0].html).toContain('Sign in with your school Google account');
      expect((await inspect(secret)).body.data.methods).toEqual({ google: true, password: false });
      const res = await accept({ token: secret, password: 'cedar-river' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PASSWORD_SIGN_IN_OFF');
    });

    it('with classrooms off, accepting still sets up the account but signs no one in', async () => {
      await pool.query(`UPDATE school_classroom_settings SET enabled = FALSE`);
      const secret = await invitedSecret(amalId);
      const res = await accept({ token: secret, password: 'cedar-river' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ activated: true, signedIn: false, code: 'CLASSROOM_DISABLED', message: expect.any(String) });
      expect((await invitesOf(amalId))[0].end_reason).toBe('accepted');
    });

    it("another school's admin token changes nothing: the endpoints ignore Authorization", async () => {
      const secret = await invitedSecret(amalId);
      const res = await pub('/api/auth/student-invite')
        .set('Authorization', 'Bearer not-a-real-token')
        .send({ token: secret });
      expect(res.status).toBe(200);
      expect(res.body.data.school.code).toBe('ALHAADIACADEMY');
    });

    it('invited before rollover, accepted after: the student lands on the active year\'s row', async () => {
      const secret = await invitedSecret(amalId);
      const login = await loginOf(amalId);
      // Roll over by hand: next year becomes active with Amal's promoted row and its link.
      const next = await nextYear();
      const amalNext = await student('Amal Haddad', '6', { yearId: next, studentEmail: 'amal.haddad@example.com', previousId: amalId });
      await pool.query(`INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [login.user_id, amalNext, next]);
      await pool.query(`UPDATE school_years SET is_active = (school_year_id = $1) WHERE school = 'ALHAADIACADEMY'`, [next]);

      const res = await accept({ token: secret, password: 'cedar-river' });
      expect(res.status).toBe(200);
      expect((await me(res.body.data.token)).body.data.student.studentId).toBe(amalNext);
    });
  });

  describe('other ways in (spec §3.9)', () => {
    let ip = 100;
    let addr;
    beforeEach(() => { ip += 1; addr = `10.9.1.${ip}`; });
    const pub = (path) => request(getApp()).post(path).set('X-Forwarded-For', addr);

    it('a student who has not set up yet gets INVITE_PENDING from password sign-in and from Forgot password', async () => {
      await invite([amalId]);
      const login = await pub('/api/auth/login').send({ email: 'amal.haddad@example.com', password: 'anything-at-all' });
      expect(login.status).toBe(403);
      expect(login.body).toMatchObject({
        code: 'INVITE_PENDING',
        message: "You haven't set up your account yet. Use the invite in your email, or Continue with Google.",
      });
      const forgot = await pub('/api/auth/request-password-reset').send({ email: 'amal.haddad@example.com' });
      expect(forgot.status).toBe(403);
      expect(forgot.body.code).toBe('INVITE_PENDING');
      expect((await pool.query(`SELECT 1 FROM password_reset_tokens`)).rows).toHaveLength(0);
    });

    it('a Google-only school refuses student password sign-in and Forgot password', async () => {
      await invite([amalId]);
      const u = await loginOf(amalId);
      await pool.query(`UPDATE users SET password = '$2b$10$hashedpasswordvalue' WHERE user_id = $1`, [u.user_id]);
      await pool.query(`UPDATE school_classroom_settings SET student_sign_in = 'google_only'`);
      const login = await pub('/api/auth/login').send({ email: 'amal.haddad@example.com', password: 'whatever' });
      expect(login.status).toBe(403);
      expect(login.body).toMatchObject({ code: 'PASSWORD_SIGN_IN_OFF', message: 'Your school uses Google to sign in. Tap Continue with Google.' });
      expect((await pub('/api/auth/request-password-reset').send({ email: 'amal.haddad@example.com' })).body.code)
        .toBe('PASSWORD_SIGN_IN_OFF');
      // Staff are untouched by a student setting.
      expect((await pub('/api/auth/login').send({ email: 'office@example.com', password: 'wrong' })).status).toBe(401);
    });

    it("a pending student's first Google sign-in on /login ends the invite, kills the reset token and tells guardians once (R2)", async () => {
      await pool.query(
        `INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school)
         VALUES ($1, $2, 'Mona Haddad', 'mona.haddad@example.com', 'Mother', 'ALHAADIACADEMY')`, [amalId, MOTHER_ID],
      );
      await invite([amalId]);
      const u = await loginOf(amalId);
      await pool.query(`INSERT INTO password_reset_tokens (user_id, expires_at) VALUES ($1, NOW() + interval '1 day')`, [u.user_id]);
      mockSend.mockClear();
      verifySignInCode.mockResolvedValue({
        sub: 'google-sub-amal', email: 'amal.haddad@example.com', emailVerified: true, hd: null,
        givenName: 'Amal', familyName: 'Haddad', name: 'Amal Haddad',
      });
      const res = await pub('/api/auth/google').send({ code: 'c', intent: 'login' });
      expect(res.status).toBe(200);
      expect((await invitesOf(amalId))[0]).toMatchObject({ end_reason: 'accepted', accepted_via: 'google' });
      expect((await pool.query(`SELECT 1 FROM password_reset_tokens WHERE user_id = $1`, [u.user_id])).rows).toHaveLength(0);
      expect(mockSend.mock.calls.map(([m]) => m.to)).toEqual(['mona.haddad@example.com']);
      expect(mockSend.mock.calls[0][0].html).toContain('(signed in with Google)');

      // Signing in again sends nothing more.
      mockSend.mockClear();
      expect((await pub('/api/auth/google').send({ code: 'c', intent: 'login' })).status).toBe(200);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('Google on /login for a student on a declared domain must come from that Workspace domain', async () => {
      await pool.query(`UPDATE school_classroom_settings SET student_email_domains = '{example.com}'`);
      await invite([amalId]);
      verifySignInCode.mockResolvedValue({
        sub: 'google-sub-amal', email: 'amal.haddad@example.com', emailVerified: true, hd: null,
        givenName: 'Amal', familyName: 'Haddad', name: 'Amal Haddad',
      });
      const res = await pub('/api/auth/google').send({ code: 'c', intent: 'login' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('GOOGLE_WRONG_DOMAIN');
      expect((await loginOf(amalId)).google_sub).toBeNull();
    });

    it("a student's first QR sign-in counts as activation and sends no guardian email", async () => {
      const { issueQrSecret, qrToken } = require('../../../services/classroom/studentLogin');
      await invite([samiId]);
      const u = await loginOf(samiId);
      const { secret, hash } = issueQrSecret();
      await pool.query(`UPDATE student_accounts SET qr_secret_hash = $2, qr_issued_at = NOW() WHERE user_id = $1`, [u.user_id, hash]);
      mockSend.mockClear();
      const res = await pub('/api/auth/student-qr').send({ token: qrToken(u.user_id, secret) });
      expect(res.status).toBe(200);
      const { rows: [acct] } = await pool.query(`SELECT * FROM student_accounts WHERE user_id = $1`, [u.user_id]);
      expect(acct).toMatchObject({ activated_via: 'card', guardians_notified_at: null });
      expect(mockSend).not.toHaveBeenCalled();
      expect(rowOf(await list(), samiId)).toMatchObject({ status: 'active', signInMethod: 'card' });
    });
  });

  describe('credential hygiene (spec §3.6)', () => {
    let ip = 200;
    let addr;
    beforeEach(() => { ip += 1; addr = `10.9.2.${ip}`; });
    const pub = (path) => request(getApp()).post(path).set('X-Forwarded-For', addr);
    const me = (token) => request(getApp()).get('/api/student/me').set('Authorization', `Bearer ${token}`);
    const acceptWithGoogle = async (studentId, email) => {
      mockSend.mockClear();
      await invite([studentId]);
      const secret = secretIn(mockSend.mock.calls[0][0].html);
      verifySignInCode.mockResolvedValue({
        sub: 'google-sub-stranger', email, emailVerified: true, hd: null, givenName: 'X', familyName: 'Y', name: 'X Y',
      });
      const res = await pub('/api/auth/student-invite/accept').send({ token: secret, googleCode: 'code' });
      expect(res.status).toBe(200);
      return res.body.data.token;
    };

    it("editing the address ends the stranger's Google link and session (Review Focus 5)", async () => {
      // The office mistyped Amal's address; whoever owns the typo accepted with Google.
      await pool.query(`UPDATE students SET student_email = 'amal.hadad@example.com' WHERE student_id = $1`, [amalId]);
      const strangerToken = await acceptWithGoogle(amalId, 'amal.hadad@example.com');
      expect((await me(strangerToken)).status).toBe(200);

      // Sessions are compared by the second they were issued.
      await new Promise((r) => setTimeout(r, 1100));
      const fixed = await authenticatedRequest('patch', `${BASE}/${amalId}`, asAdmin).send({ studentEmail: 'amal.haddad@example.com' });
      expect(fixed.status).toBe(200);
      // Back to Invited: the accepted invite stays the latest one, and the row needs a new invite.
      expect(fixed.body.data).toMatchObject({
        status: 'invited', signInMethod: null, needsAttention: true, invite: { state: 'accepted' },
        account: { email: 'amal.haddad@example.com' },
      });

      const gone = await me(strangerToken);
      expect(gone.status).toBe(401);
      expect(gone.body.code).toBe('SESSION_REVOKED');
      const auth = await request(getApp()).get('/api/auth/me').set('Authorization', `Bearer ${strangerToken}`);
      expect(auth.status).toBe(401);
      expect(auth.body.code).toBe('SESSION_REVOKED');
      const profile = await request(getApp()).get('/api/profile').set('Authorization', `Bearer ${strangerToken}`);
      expect(profile.status).toBe(401);

      // The stranger's Google account no longer opens anything.
      verifySignInCode.mockResolvedValue({
        sub: 'google-sub-stranger', email: 'amal.hadad@example.com', emailVerified: true, hd: null, givenName: 'X', familyName: 'Y', name: 'X Y',
      });
      const again = await pub('/api/auth/google').send({ code: 'c', intent: 'login' });
      expect(again.status).toBe(404);
      expect(again.body.code).toBe('GOOGLE_NO_ACCOUNT');
      const login = await loginOf(amalId);
      expect(login).toMatchObject({ google_sub: null, password: '!', email: 'amal.haddad@example.com' });
    });

    it('editing the address also resets a password someone else set', async () => {
      mockSend.mockClear();
      await invite([ramiId]);
      const secret = secretIn(mockSend.mock.calls[0][0].html);
      expect((await pub('/api/auth/student-invite/accept').send({ token: secret, password: 'cedar-river' })).status).toBe(200);
      await authenticatedRequest('patch', `${BASE}/${ramiId}`, asAdmin).send({ studentEmail: 'rami.o@example.com' });
      const login = await pub('/api/auth/login').send({ email: 'rami.o@example.com', password: 'cedar-river' });
      expect(login.status).toBe(403);
      expect(login.body.code).toBe('INVITE_PENDING');
    });

    it('a Google-only school has no student password to reset', async () => {
      await acceptWithGoogle(amalId, 'amal.haddad@example.com');
      await pool.query(`UPDATE school_classroom_settings SET student_sign_in = 'google_only'`);
      const res = await authenticatedRequest('post', `${BASE}/${amalId}/reset-password`, asAdmin);
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('Your school uses Google sign-in, so students have no password to reset.');
    });
  });
});