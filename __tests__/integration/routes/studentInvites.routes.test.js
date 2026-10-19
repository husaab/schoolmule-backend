// Student invitations: the invite record, its one-time link, resend, cancel,
// preview and next-year links (admin side), and accepting it (student side).
// Synthetic identities only: every address is @example.com.

const mockSend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: (...args) => mockSend(...args) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const { hashInviteSecret } = require('../../../services/classroom/studentInvites');

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
});
