// Student account requests: a student asks from the public signup page; the
// office approves it on the Approvals page by matching the student's existing
// record, which sends the normal invite. Synthetic identities only.

const mockSend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: (...args) => mockSend(...args) } })),
}));

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const MOTHER_ID = '550e8400-e29b-41d4-a716-446655440002';
const ARCHIVED_ADMIN_ID = '550e8400-e29b-41d4-a716-446655440003';
const OTHER_ADMIN_ID = '550e8400-e29b-41d4-a716-446655440004';

const asAdmin = { userId: ADMIN_ID, username: 'Office Admin', email: 'office@example.com', role: 'ADMIN' };
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'teacher@example.com', role: 'TEACHER' };
const asOtherAdmin = { userId: OTHER_ADMIN_ID, username: 'Play Admin', email: 'play.admin@example.com', role: 'ADMIN', school: 'PLAYGROUND' };
const ADMIN = '/api/admin/student-requests';
const PUBLIC = '/api/auth/student-request';
const SUBMITTED = { status: 'success', data: { received: true } };

describe('Integration: student account requests', () => {
  let app;
  let pool;
  let yearId, amalId, samiId, linaId, ramiId;
  let ip = 0;

  beforeAll(() => { app = getApp(); pool = getTestPool(); });

  // Each public call from its own network unless a test says otherwise, so
  // the per-network limits never couple tests.
  const submit = (body, from) => {
    ip += 1;
    return request(app).post(PUBLIC).set('X-Forwarded-For', from ?? `10.9.${Math.floor(ip / 250)}.${ip % 250}`).send(body);
  };
  const form = (overrides = {}) => ({
    school: 'ALHAADIACADEMY', firstName: 'Amal', lastName: 'Haddad', grade: '5', email: 'amal.haddad@example.com', ...overrides,
  });
  const user = (id, email, first, last, role, extra = {}) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, is_archived)
     VALUES ($1, $2, $3, 'hashed', $4, $5, $6, $7, $8, true, $9)`,
    [id, email, `${first} ${last}`, first, last, extra.school ?? 'ALHAADIACADEMY', role, extra.verified ?? true, extra.archived ?? false],
  );
  const student = (name, grade, extra = {}) => pool.query(
    `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id, student_email, mother_email, previous_student_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING student_id`,
    [name, grade, extra.school ?? 'ALHAADIACADEMY', extra.yearId ?? yearId, TEACHER_ID, extra.studentEmail ?? null,
      extra.motherEmail ?? null, extra.previousId ?? null],
  ).then((r) => r.rows[0].student_id);
  const requests = async () => (await pool.query(`SELECT * FROM student_account_requests ORDER BY created_at`)).rows;
  const requestRow = (status = 'pending', overrides = {}) => pool.query(
    `INSERT INTO student_account_requests (school, first_name, last_name, grade, email, status, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'pending' THEN NULL ELSE NOW() END) RETURNING request_id`,
    [overrides.school ?? 'ALHAADIACADEMY', overrides.firstName ?? 'Amal', overrides.lastName ?? 'Haddad',
      overrides.grade ?? '5', overrides.email ?? 'amal.haddad@example.com', status],
  ).then((r) => r.rows[0].request_id);
  const loginOf = async (studentId) => (await pool.query(
    `SELECT u.* FROM student_account_links l JOIN users u ON u.user_id = l.user_id WHERE l.student_id = $1`, [studentId],
  )).rows[0];
  const emailOf = async (studentId) => (await pool.query(`SELECT student_email FROM students WHERE student_id = $1`, [studentId])).rows[0].student_email;
  const studentCount = async () => (await pool.query(`SELECT COUNT(*)::int AS n FROM students`)).rows[0].n;
  const approve = (id, body, as = asAdmin) => authenticatedRequest('post', `${ADMIN}/${id}/approve`, as)
    .send({ consentConfirmed: true, ...body });
  const notices = () => mockSend.mock.calls.map(([mail]) => mail).filter((m) => /Student account requests/.test(m.subject));
  const invites = () => mockSend.mock.calls.map(([mail]) => mail).filter((m) => /Set up your/.test(m.subject));
  // The admins' email goes out after the student's answer (so the answer's
  // timing says nothing): wait for it, up to 2 s.
  const settle = async (count) => {
    for (let waited = 0; notices().length < count && waited < 2000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return notices();
  };

  beforeEach(async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: 'email-1' } });
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    await user(ADMIN_ID, 'office@example.com', 'Office', 'Admin', 'ADMIN');
    await user(ARCHIVED_ADMIN_ID, 'old.office@example.com', 'Old', 'Office', 'ADMIN', { archived: true });
    await user(TEACHER_ID, 'teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(MOTHER_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    amalId = await student('Amal Haddad', '5', { motherEmail: 'mona.haddad@example.com' });
    samiId = await student('Sami Haddad', '2');
    linaId = await student('Lina Nassar', 'JK');
    ramiId = await student('Rami Omar', '6');
  });

  describe('public: asking for an account', () => {
    it('stores one pending request (trimmed, address lowercased) and emails the active admins once, with no names in it', async () => {
      const res = await submit(form({ firstName: ' Amal ', email: ' Amal.Haddad@Example.com ' }));
      expect(res.status).toBe(200);
      expect(res.body).toEqual(SUBMITTED);
      const [row] = await requests();
      expect(row).toMatchObject({
        school: 'ALHAADIACADEMY', first_name: 'Amal', last_name: 'Haddad', grade: '5', email: 'amal.haddad@example.com',
        status: 'pending', decided_at: null, student_id: null, user_id: null,
      });
      // No login, no student: nothing exists until an admin approves.
      expect((await pool.query(`SELECT 1 FROM users WHERE email = 'amal.haddad@example.com'`)).rows).toHaveLength(0);

      const [mail] = await settle(1);
      expect(notices()).toHaveLength(1);
      expect(mail.to).toEqual(['office@example.com']);
      expect(mail.subject).toBe('Student account requests at Al Haadi Academy');
      expect(mail.html).toContain('1 student account request is');
      expect(mail.html).toContain('/admin-panel/approvals?role=STUDENT');
      expect(mail.html).not.toContain('Amal');
      expect(mail.html).not.toContain('amal.haddad');
    });

    it('works at every school: a school that never saved classroom settings still takes requests', async () => {
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM school_classroom_settings`)).rows[0].n).toBe(0);
      expect((await submit(form())).body).toEqual(SUBMITTED);
      expect(await requests()).toHaveLength(1);
    });

    it('asking again with the same address refreshes the one pending request and sends no second email', async () => {
      await submit(form());
      const [first] = await requests();
      await settle(1);
      await submit(form({ firstName: 'Amaal', grade: '6', email: 'AMAL.HADDAD@example.com' }));
      const rows = await requests();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ first_name: 'Amaal', grade: '6', created_at: first.created_at });
      expect(await settle(2)).toHaveLength(1);
    });

    it('answers exactly the same and stores nothing for the honeypot, an address that has an account, or an address declined before', async () => {
      expect((await submit(form({ website: 'http://spam.example' }))).body).toEqual(SUBMITTED);
      // An account anywhere, any capitals.
      await user(OTHER_ADMIN_ID, 'Rami.Omar@Example.com', 'Rami', 'Omar', 'PARENT');
      expect((await submit(form({ firstName: 'Rami', lastName: 'Omar', email: 'rami.omar@example.com' }))).body).toEqual(SUBMITTED);
      await requestRow('declined', { email: 'sami.haddad@example.com', firstName: 'Sami' });
      expect((await submit(form({ firstName: 'Sami', email: 'sami.haddad@example.com', grade: '2' }))).body).toEqual(SUBMITTED);
      expect((await requests()).map((r) => [r.email, r.status])).toEqual([['sami.haddad@example.com', 'declined']]);
      expect(await settle(1)).toHaveLength(0);
    });

    it('refuses what the student can fix: a bad form, an unknown school, an address off the school domain, a grade before student accounts', async () => {
      expect((await submit(form({ email: 'amal@' }))).body).toMatchObject({ code: 'INVALID_REQUEST', message: 'Enter your school email address.' });
      const unknown = await submit(form({ school: 'NOT_A_SCHOOL' }));
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('UNKNOWN_SCHOOL');

      await pool.query(`INSERT INTO school_classroom_settings (school, student_email_domains) VALUES ('ALHAADIACADEMY', '{students.example.org}')`);
      const off = await submit(form());
      expect(off.status).toBe(400);
      expect(off.body).toMatchObject({ code: 'EMAIL_DOMAIN', message: 'Use your school email address (…@students.example.org).' });
      expect((await submit(form({ email: 'amal.haddad@students.example.org' }))).body).toEqual(SUBMITTED);

      const jk = await submit(form({ firstName: 'Lina', lastName: 'Nassar', grade: 'JK', email: 'lina@students.example.org' }));
      expect(jk.status).toBe(400);
      expect(jk.body).toMatchObject({ code: 'BELOW_LOGIN_GRADE', message: 'Student accounts start at Grade 1. Your teacher can help you sign in.' });
      expect(await requests()).toHaveLength(1);
    });

    it('a full queue (300 waiting) takes no more', async () => {
      await pool.query(
        `INSERT INTO student_account_requests (school, first_name, last_name, grade, email)
         SELECT 'ALHAADIACADEMY', 'Kid', 'Number' || n, '4', 'kid' || n || '@example.com' FROM generate_series(1, 300) n`,
      );
      const res = await submit(form());
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('TOO_MANY_REQUESTS');
    });

    it('admins hear at most once an hour per school, however many students ask', async () => {
      await submit(form());
      await settle(1);
      await submit(form({ firstName: 'Rami', lastName: 'Omar', email: 'rami.omar@example.com', grade: '6' }));
      expect(await settle(2)).toHaveLength(1);
      await pool.query(`UPDATE schools SET student_requests_notified_at = NOW() - INTERVAL '61 minutes'`);
      await submit(form({ firstName: 'Sami', email: 'sami.haddad@example.com', grade: '2' }));
      expect(await settle(2)).toHaveLength(2);
      expect(notices()[1].html).toContain('3 student account requests are');
    });

    it('limits one network: 5 an hour for one address, while a class asking together still fits', async () => {
      const from = '10.77.0.1';
      for (let n = 0; n < 5; n += 1) expect((await submit(form(), from)).status).toBe(200);
      const sixth = await submit(form(), from);
      expect(sixth.status).toBe(429);
      expect(sixth.body.code).toBe('TOO_MANY_REQUESTS');
      // Another student on the same network is fine.
      expect((await submit(form({ firstName: 'Rami', lastName: 'Omar', email: 'rami.omar@example.com', grade: '6' }), from)).status).toBe(200);
    });
  });

  describe('admin: the queue', () => {
    it('lists pending and declined requests of the admin school only, newest first, with the likeliest student', async () => {
      const amalReq = await requestRow('pending');
      await pool.query(`UPDATE student_account_requests SET created_at = NOW() - INTERVAL '1 day' WHERE request_id = $1`, [amalReq]);
      const declined = await requestRow('declined', { firstName: 'Zainab', lastName: 'Ali', email: 'zainab@example.com' });
      await requestRow('approved', { firstName: 'Rami', lastName: 'Omar', email: 'rami.omar@example.com' });
      await pool.query(`INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT DO NOTHING`);
      await requestRow('pending', { school: 'PLAYGROUND', email: 'elsewhere@example.com' });

      const res = await authenticatedRequest('get', ADMIN, asAdmin);
      expect(res.status).toBe(200);
      const list = res.body.data.requests;
      expect(list.map((r) => r.requestId)).toEqual([declined, amalReq]);
      expect(list[1]).toMatchObject({
        name: 'Amal Haddad', grade: '5', email: 'amal.haddad@example.com', status: 'pending', addressTaken: false,
        suggestion: { studentId: amalId, name: 'Amal Haddad', grade: '5', kind: 'exact', hasLogin: false },
      });
      expect(list[0]).toMatchObject({ status: 'declined', suggestion: null });
    });

    it('only admins: a teacher is refused, and another school cannot see or touch these requests', async () => {
      const id = await requestRow('pending');
      expect((await authenticatedRequest('get', ADMIN, asTeacher)).status).toBe(403);
      await pool.query(`INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT DO NOTHING`);
      await user(OTHER_ADMIN_ID, 'play.admin@example.com', 'Play', 'Admin', 'ADMIN', { school: 'PLAYGROUND' });
      expect((await authenticatedRequest('get', ADMIN, asOtherAdmin)).body.data.requests).toEqual([]);
      expect((await authenticatedRequest('get', `${ADMIN}/${id}/candidates`, asOtherAdmin)).status).toBe(404);
      expect((await approve(id, { studentId: amalId, email: 'amal.haddad@example.com' }, asOtherAdmin)).status).toBe(404);
      expect((await authenticatedRequest('post', `${ADMIN}/${id}/decline`, asOtherAdmin)).status).toBe(404);
      expect((await requests())[0].status).toBe('pending');
    });

    it("candidates: the suggested students and the admin's pick, each with the address's problems, and the roster to search", async () => {
      const id = await requestRow('pending', { email: 'mona.haddad@example.com' });
      const res = await authenticatedRequest('get', `${ADMIN}/${id}/candidates`, asAdmin);
      expect(res.status).toBe(200);
      const { candidates, students, email, noticeVersion } = res.body.data;
      expect(email).toBe('mona.haddad@example.com');
      expect(noticeVersion).toBe('2026-10');
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ studentId: amalId, kind: 'exact', hasLogin: false });
      // A parent's address is blocked, worded as everywhere else.
      expect(candidates[0].problems.map((p) => [p.code, p.blocking])).toContainEqual(['email_in_use', true]);
      expect(students.map((s) => s.name)).toEqual(['Amal Haddad', 'Lina Nassar', 'Rami Omar', 'Sami Haddad']);

      // The admin edits the address and picks a JK student from the list.
      const edited = await authenticatedRequest('get', `${ADMIN}/${id}/candidates?email=lina.nassar@example.com&studentId=${linaId}`, asAdmin);
      const lina = edited.body.data.candidates.find((c) => c.studentId === linaId);
      expect(lina.kind).toBe('picked');
      expect(lina.problems[0]).toEqual({ code: 'below_login_grade', blocking: true, message: 'Student accounts start at Grade 1.' });
      expect(edited.body.data.candidates[0].problems.filter((p) => p.blocking)).toEqual([]);
    });

    it('approve: the address goes on the existing record (and next year\'s), the login and invite are made, the request is approved; no new student', async () => {
      const id = await requestRow('pending', { email: 'amal.h@example.com' });
      const nextYearId = (await pool.query(
        `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
         SELECT school, school_id, '2026-2027', '2026-09-01', '2027-06-30', false FROM school_years WHERE school_year_id = $1
         RETURNING school_year_id`, [yearId],
      )).rows[0].school_year_id;
      const nextRow = await student('Amal Haddad', '6', { yearId: nextYearId, previousId: amalId });
      const before = await studentCount();

      const res = await approve(id, { studentId: amalId, email: ' Amal.H@Example.com ' });
      expect(res.status).toBe(200);
      expect(res.body.data.request).toMatchObject({ requestId: id, status: 'approved' });
      expect(res.body.data.invite).toMatchObject({ inviteSent: true, message: 'Invite sent to amal.h@example.com' });

      expect(await studentCount()).toBe(before);
      expect(await emailOf(amalId)).toBe('amal.h@example.com');
      expect(await emailOf(nextRow)).toBe('amal.h@example.com');
      const login = await loginOf(amalId);
      expect(login).toMatchObject({ email: 'amal.h@example.com', role: 'STUDENT', password: '!' });
      const [row] = await requests();
      expect(row).toMatchObject({ status: 'approved', student_id: amalId, user_id: login.user_id, decided_by: ADMIN_ID });
      expect((await pool.query(`SELECT consent_by, consent_notice_version FROM student_accounts WHERE user_id = $1`, [login.user_id])).rows[0])
        .toEqual({ consent_by: ADMIN_ID, consent_notice_version: '2026-10' });
      expect(invites().map((m) => m.to)).toEqual(['amal.h@example.com']);
      // Approved requests leave the queue.
      expect((await authenticatedRequest('get', ADMIN, asAdmin)).body.data.requests).toEqual([]);
    });

    it('approve refuses, and writes nothing, without consent, for a blocked address, a student who has a login, or a grade before student accounts', async () => {
      const id = await requestRow('pending');
      expect((await approve(id, { studentId: amalId, email: 'amal.haddad@example.com', consentConfirmed: false })).body.code).toBe('CONSENT_REQUIRED');

      const parent = await approve(id, { studentId: amalId, email: 'mona.haddad@example.com' });
      expect(parent.status).toBe(409);
      expect(parent.body.code).toBe('BLOCKING_PROBLEMS');
      expect(parent.body.data.problems.map((p) => p.code)).toContain('email_in_use');

      const jk = await approve(id, { studentId: linaId, email: 'lina.nassar@example.com' });
      expect(jk.status).toBe(409);
      expect(jk.body.code).toBe('BLOCKING_PROBLEMS');
      expect(jk.body.message).toBe('Student accounts start at Grade 1.');

      await approve(await requestRow('pending', { firstName: 'Rami', lastName: 'Omar', email: 'rami.omar@example.com' }),
        { studentId: ramiId, email: 'rami.omar@example.com' });
      const taken = await approve(id, { studentId: ramiId, email: 'amal.haddad@example.com' });
      expect(taken.status).toBe(409);
      expect(taken.body.code).toBe('ALREADY_HAS_LOGIN');

      expect(await emailOf(amalId)).toBeNull();
      expect(await emailOf(linaId)).toBeNull();
      expect(await loginOf(amalId)).toBeUndefined();
      expect((await requests()).find((r) => r.request_id === id).status).toBe('pending');
    });

    it('two admins approving at once make one login; the other is told and nothing half-done is left', async () => {
      const id = await requestRow('pending');
      const [a, b] = await Promise.all([
        approve(id, { studentId: amalId, email: 'amal.haddad@example.com' }),
        approve(id, { studentId: amalId, email: 'amal.haddad@example.com' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM student_account_links WHERE student_id = $1`, [amalId])).rows[0].n).toBe(1);
      expect((await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'STUDENT'`)).rows[0].n).toBe(1);
    });

    it("two requests for one student at once: one is approved, the other stays pending and the record keeps the winner's address", async () => {
      const first = await requestRow('pending', { email: 'amal.one@example.com' });
      const second = await requestRow('pending', { email: 'amal.two@example.com' });
      const [a, b] = await Promise.all([
        approve(first, { studentId: amalId, email: 'amal.one@example.com' }),
        approve(second, { studentId: amalId, email: 'amal.two@example.com' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const winner = a.status === 200 ? 'amal.one@example.com' : 'amal.two@example.com';
      expect(await emailOf(amalId)).toBe(winner);
      expect((await requests()).map((r) => r.status).sort()).toEqual(['approved', 'pending']);
    });

    it('an invite email that fails still approves (the login exists; Resend invite recovers it)', async () => {
      const id = await requestRow('pending');
      mockSend.mockRejectedValueOnce(new Error('resend down'));
      const res = await approve(id, { studentId: amalId, email: 'amal.haddad@example.com' });
      expect(res.status).toBe(200);
      expect(res.body.data.invite.inviteSent).toBe(false);
      expect((await requests())[0].status).toBe('approved');
    });

    it('decline, restore and delete: each only from the right state', async () => {
      const id = await requestRow('pending');
      const declined = await authenticatedRequest('post', `${ADMIN}/${id}/decline`, asAdmin);
      expect(declined.status).toBe(200);
      expect(declined.body.data.request).toMatchObject({ status: 'declined', decidedAt: expect.any(String) });
      expect((await requests())[0].decided_by).toBe(ADMIN_ID);
      expect((await authenticatedRequest('post', `${ADMIN}/${id}/decline`, asAdmin)).body).toMatchObject({ code: 'WRONG_STATE' });
      expect((await approve(id, { studentId: amalId, email: 'amal.haddad@example.com' })).body.code).toBe('REQUEST_NOT_PENDING');

      expect((await authenticatedRequest('post', `${ADMIN}/${id}/restore`, asAdmin)).body.data.request.status).toBe('pending');
      expect((await authenticatedRequest('delete', `${ADMIN}/${id}`, asAdmin)).body.code).toBe('WRONG_STATE');

      // A newer pending request for the same address blocks the restore.
      await authenticatedRequest('post', `${ADMIN}/${id}/decline`, asAdmin);
      await requestRow('pending');
      const clash = await authenticatedRequest('post', `${ADMIN}/${id}/restore`, asAdmin);
      expect(clash.status).toBe(409);
      expect(clash.body.code).toBe('ADDRESS_PENDING');

      expect((await authenticatedRequest('delete', `${ADMIN}/${id}`, asAdmin)).body.data).toEqual({ deleted: true });
      expect((await requests()).map((r) => r.status)).toEqual(['pending']);
      expect((await authenticatedRequest('delete', `${ADMIN}/not-a-uuid`, asAdmin)).status).toBe(404);
    });
  });
});
