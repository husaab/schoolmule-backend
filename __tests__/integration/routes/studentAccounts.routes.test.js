// Student accounts (admin API) and the school's classroom settings.
// Synthetic identities only: every address is @example.com.

const mockSend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: (...args) => mockSend(...args) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const MOTHER_ID = '550e8400-e29b-41d4-a716-446655440002';
const FATHER_ID = '550e8400-e29b-41d4-a716-446655440003';

const asAdmin = { userId: ADMIN_ID, username: 'Office Admin', email: 'office@example.com', role: 'ADMIN' };
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'teacher@example.com', role: 'TEACHER' };
const asParent = { userId: MOTHER_ID, username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };
const asStudent = {
  userId: '550e8400-e29b-41d4-a716-446655440010', username: 'Amal Haddad', email: 'amal.haddad@example.com',
  role: 'STUDENT', roles: ['STUDENT'],
};

const BASE = '/api/admin/student-accounts';

describe('Integration: Student accounts', () => {
  let pool;
  let yearId, amalId, samiId, linaId, ramiId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role, password = 'hashed') => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, $4, $5, $6, 'ALHAADIACADEMY', $7, true, true)`,
    [id, email, `${first} ${last}`, password, first, last, role],
  );
  const student = (name, grade, extra = {}) => pool.query(
    `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id, student_email, mother_email)
     VALUES ($1, $2, 'ALHAADIACADEMY', $3, $4, $5, $6) RETURNING student_id`,
    [name, grade, extra.yearId ?? yearId, TEACHER_ID, extra.studentEmail ?? null, extra.motherEmail ?? null],
  ).then((r) => r.rows[0].student_id);
  const setEmail = (id, email) => pool.query(`UPDATE students SET student_email = $2 WHERE student_id = $1`, [id, email]);
  const invite = (studentIds, extra = {}) => authenticatedRequest('post', `${BASE}/invite`, asAdmin)
    .send({ studentIds, consentConfirmed: true, ...extra });
  const userOf = async (studentId) => (await pool.query(
    `SELECT u.* FROM student_account_links l JOIN users u ON u.user_id = l.user_id WHERE l.student_id = $1`, [studentId],
  )).rows[0];
  const activate = async (studentId) => {
    const u = await userOf(studentId);
    await pool.query(`UPDATE users SET password = '$2b$10$hashedpasswordvalue' WHERE user_id = $1`, [u.user_id]);
    return u;
  };
  const list = async (query = '') => {
    const res = await authenticatedRequest('get', `${BASE}${query}`, asAdmin);
    expect(res.status).toBe(200);
    return res.body.data;
  };
  const rowOf = (data, studentId) => data.students.find((s) => s.studentId === studentId);

  beforeEach(async () => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: 'email-1' } });
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;

    await user(ADMIN_ID, 'office@example.com', 'Office', 'Admin', 'ADMIN');
    await user(TEACHER_ID, 'teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(MOTHER_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    await user(FATHER_ID, 'karim.haddad@example.com', 'Karim', 'Haddad', 'PARENT');

    linaId = await student('Lina Haddad', 'SK');
    amalId = await student('Amal Haddad', '2', { studentEmail: 'Amal.Haddad@Example.com' });
    ramiId = await student('Rami Haddad', '2');
    samiId = await student('Sami Haddad', '5', { studentEmail: 'sami.haddad@example.com' });
    await pool.query(
      `INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school)
       VALUES ($1, $3, 'Mona Haddad', 'mona.haddad@example.com', 'Mother', 'ALHAADIACADEMY'),
              ($2, $3, 'Mona Haddad', 'mona.haddad@example.com', 'Mother', 'ALHAADIACADEMY'),
              ($2, $4, 'Karim Haddad', 'karim.haddad@example.com', 'Father', 'ALHAADIACADEMY')`,
      [amalId, samiId, MOTHER_ID, FATHER_ID],
    );

    await pool.query(
      `INSERT INTO school_classroom_settings (school, enabled) VALUES ('ALHAADIACADEMY', TRUE)`,
    );
  });

  // 1
  it("invite creates a STUDENT user with the invite sentinel, an account row with consent, and a link to the student's year", async () => {
    const res = await invite([amalId]);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toMatchObject({ invited: 1, skipped: 0 });
    const [result] = res.body.data.results;
    expect(result).toMatchObject({ studentId: amalId, outcome: 'invited', reason: null, inviteSent: true });
    expect(typeof result.message).toBe('string');

    const { rows: [u] } = await pool.query(`SELECT * FROM users WHERE user_id = $1`, [result.userId]);
    expect(u).toMatchObject({
      email: 'amal.haddad@example.com', password: '!', role: 'STUDENT', school: 'ALHAADIACADEMY',
      first_name: 'Amal', last_name: 'Haddad', is_verified: true, is_verified_school: true, is_archived: false,
    });

    const { rows: [acct] } = await pool.query(`SELECT * FROM student_accounts WHERE user_id = $1`, [u.user_id]);
    expect(acct).toMatchObject({
      school: 'ALHAADIACADEMY', consent_by: ADMIN_ID, consent_notice_version: '2026-10', created_by: ADMIN_ID,
      qr_secret_hash: null,
    });
    expect(acct.consent_at).toBeInstanceOf(Date);

    const { rows: links } = await pool.query(`SELECT * FROM student_account_links WHERE user_id = $1`, [u.user_id]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ student_id: amalId, school_year_id: yearId, linked_by: ADMIN_ID });

    // The invite is a student_invites row (studentInvites.routes.test.js covers it), not a reset token.
    const { rows: invites } = await pool.query(`SELECT send_status FROM student_invites WHERE user_id = $1`, [u.user_id]);
    expect(invites).toEqual([{ send_status: 'sent' }]);
    expect((await pool.query(`SELECT 1 FROM password_reset_tokens WHERE user_id = $1`, [u.user_id])).rows).toHaveLength(0);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const payload = mockSend.mock.calls[0][0];
    expect(payload.to).toBe('amal.haddad@example.com');
    expect(payload.subject).toBe('Set up your Al Haadi Academy SchoolMule account');
    expect(payload.html).toMatch(/\/student-invite#[A-Za-z0-9_-]{43}/);
    expect(payload.html).toContain('Your SchoolMule student account');
    expect(payload.html).toContain('Hi Amal,');
  });

  // 2
  it('invite skips an address used by a parent account, case-insensitively (email_in_use)', async () => {
    await setEmail(samiId, 'MONA.Haddad@example.com');

    const res = await invite([samiId]);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ invited: 0, skipped: 1 });
    expect(res.body.data.results[0]).toEqual({
      studentId: samiId, outcome: 'skipped', reason: 'email_in_use',
      message: 'Already used by a parent account in this school. Each student needs their own address.',
    });
    const { rows } = await pool.query(`SELECT 1 FROM users WHERE role::text = 'STUDENT'`);
    expect(rows).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // 3
  it('invite skips the mother_email on file (family_address)', async () => {
    await pool.query(`UPDATE students SET mother_email = 'Family.Inbox@example.com', student_email = 'family.inbox@example.com' WHERE student_id = $1`, [ramiId]);

    const res = await invite([ramiId]);

    expect(res.body.data.results[0]).toEqual({
      studentId: ramiId, outcome: 'skipped', reason: 'family_address',
      message: "This is a parent's address on file. Use the student's own school address.",
    });
    expect((await pool.query(`SELECT 1 FROM student_accounts`)).rows).toHaveLength(0);
  });

  // 4
  it("invite skips SK when loginFromGrade is '1' (below_login_grade) and the row reads not_eligible", async () => {
    await setEmail(linaId, 'lina.haddad@example.com');

    const res = await invite([linaId, amalId], { noticeVersion: '2026-10-r2' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ invited: 1, skipped: 1 });
    const byId = Object.fromEntries(res.body.data.results.map((r) => [r.studentId, r]));
    expect(byId[linaId]).toMatchObject({ outcome: 'skipped', reason: 'below_login_grade' });
    expect(byId[amalId]).toMatchObject({ outcome: 'invited', reason: null });
    const { rows: [acct] } = await pool.query(
      `SELECT consent_notice_version FROM student_accounts WHERE user_id = $1`, [byId[amalId].userId],
    );
    expect(acct.consent_notice_version).toBe('2026-10-r2');

    const lina = rowOf(await list(), linaId);
    expect(lina).toMatchObject({ status: 'not_eligible', account: null, qrEligible: false, grade: 'SK' });
  });

  it("invite only reaches this year's current rows: a past-year or withdrawn row is not found", async () => {
    const { rows: [lastYear] } = await pool.query(
      `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
       SELECT 'ALHAADIACADEMY', school_id, '2024-2025', DATE '2024-09-01', DATE '2025-06-30', FALSE
         FROM schools WHERE school_code = 'ALHAADIACADEMY'
       RETURNING school_year_id`,
    );
    const oldRow = await student('Amal Haddad', '1', { yearId: lastYear.school_year_id, studentEmail: 'amal.old@example.com' });
    await pool.query(`UPDATE students SET is_archived = true WHERE student_id = $1`, [samiId]);

    const stale = await invite([oldRow]);
    expect(stale.status).toBe(404);
    const withdrawn = await invite([amalId, samiId]);
    expect(withdrawn.status).toBe(404);
    expect((await pool.query(`SELECT 1 FROM users WHERE role::text = 'STUDENT'`)).rows).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // 5
  it('list derives Not invited / Invited / Active and flags conflicts', async () => {
    await invite([amalId, samiId]);
    await activate(samiId);
    await setEmail(ramiId, 'Karim.Haddad@example.com');

    const data = await list();

    expect(data.settings).toMatchObject({ enabled: true, loginFromGrade: '1', qrUntilGrade: '3' });
    // JK and SK first, then Grades 1-8 (the T7 ruling, M5); by name within a grade.
    expect(data.students.map((s) => s.name)).toEqual(['Lina Haddad', 'Amal Haddad', 'Rami Haddad', 'Sami Haddad']);

    const amal = rowOf(data, amalId);
    const amalUser = await userOf(amalId);
    expect(amal).toEqual({
      studentId: amalId,
      name: 'Amal Haddad',
      studentAvatar: null,
      studentPhotoUrl: null,
      grade: '2',
      homeroomTeacherName: 'Ziad Teacher',
      studentEmail: 'Amal.Haddad@Example.com',
      status: 'invited',
      account: {
        userId: amalUser.user_id,
        email: 'amal.haddad@example.com',
        createdAt: expect.any(String),
        lastLoginAt: null,
        lastSeenAt: null,
        consent: { at: expect.any(String), byName: 'Office Admin', noticeVersion: '2026-10' },
        qr: { active: false, issuedAt: null, voidedAt: null },
      },
      qrEligible: true,
      conflict: null,
      warnings: [],
      invite: { state: 'pending', sentAt: expect.any(String), expiresAt: expect.any(String), endedAt: null, error: null },
      signInMethod: null,
      needsAttention: false,
    });

    const sami = rowOf(data, samiId);
    expect(sami).toMatchObject({ status: 'active', qrEligible: false, conflict: null, signInMethod: 'password', needsAttention: false });

    const rami = rowOf(data, ramiId);
    expect(rami).toMatchObject({
      status: 'not_invited',
      account: null,
      qrEligible: false,
      conflict: { kind: 'email_in_use', message: 'Already used by a parent account in this school. Each student needs their own address.' },
    });

    expect(rowOf(data, linaId).status).toBe('not_eligible');

    expect((await list('?status=invited')).students.map((s) => s.studentId)).toEqual([amalId]);
    expect((await list('?grade=5')).students.map((s) => s.studentId)).toEqual([samiId]);
    expect((await list('?q=RAMI')).students.map((s) => s.studentId)).toEqual([ramiId]);
    expect((await list('?q=sami.haddad@')).students.map((s) => s.studentId)).toEqual([samiId]);
    expect((await authenticatedRequest('get', `${BASE}?status=bogus`, asAdmin)).status).toBe(400);
  });

  // 6
  it("rows carry the student's displayed avatar: the login's own pick over the teacher-set one (studentAvatar)", async () => {
    await invite([amalId]);
    const teacherSet = { style: 'short', skin: 1, bg: 2 };
    const ownPick = { style: 'hijab', skin: 3, bg: 4 };
    await pool.query(`UPDATE students SET avatar = $2::jsonb WHERE student_id = ANY($1::uuid[])`, [[amalId, ramiId], JSON.stringify(teacherSet)]);
    let data = await list();
    expect(rowOf(data, amalId).studentAvatar).toEqual(teacherSet);
    expect(rowOf(data, ramiId).studentAvatar).toEqual(teacherSet);
    expect(rowOf(data, samiId).studentAvatar).toBeNull();
    await pool.query(`UPDATE users SET avatar = $2::jsonb WHERE user_id = $1`, [(await userOf(amalId)).user_id, JSON.stringify(ownPick)]);
    data = await list();
    expect(rowOf(data, amalId).studentAvatar).toEqual(ownPick);
  });

  it('PATCH email on an invited account updates users.email; 409 when another user has it', async () => {
    await invite([amalId]);
    const before = await userOf(amalId);

    const ok = await authenticatedRequest('patch', `${BASE}/${amalId}`, asAdmin).send({ studentEmail: ' Amal.H@Example.com ' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ studentEmail: 'amal.h@example.com', account: { email: 'amal.h@example.com' } });
    expect((await userOf(amalId)).email).toBe('amal.h@example.com');

    const taken = await authenticatedRequest('patch', `${BASE}/${amalId}`, asAdmin).send({ studentEmail: 'TEACHER@example.com' });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({
      code: 'EMAIL_IN_USE', message: 'Already used by a teacher account in this school. Each student needs their own address.',
    });
    expect((await userOf(amalId)).email).toBe('amal.h@example.com');
    expect((await pool.query(`SELECT student_email FROM students WHERE student_id = $1`, [amalId])).rows[0].student_email)
      .toBe('amal.h@example.com');
    expect((await userOf(amalId)).user_id).toBe(before.user_id);

    // No account yet: only the student record changes.
    const plain = await authenticatedRequest('patch', `${BASE}/${ramiId}`, asAdmin).send({ studentEmail: 'rami.haddad@example.com' });
    expect(plain.status).toBe(200);
    expect(plain.body.data).toMatchObject({ studentEmail: 'rami.haddad@example.com', status: 'not_invited', account: null });

    const cleared = await authenticatedRequest('patch', `${BASE}/${ramiId}`, asAdmin).send({ studentEmail: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.studentEmail).toBeNull();

    // Without an account a bad address is refused too, not just flagged (spec §3.7).
    await pool.query(`UPDATE students SET father_email = 'Karim.Inbox@example.com' WHERE student_id = $1`, [ramiId]);
    const parentAddress = await authenticatedRequest('patch', `${BASE}/${ramiId}`, asAdmin).send({ studentEmail: 'karim.inbox@example.com' });
    expect(parentAddress.status).toBe(409);
    expect(parentAddress.body.code).toBe('FAMILY_ADDRESS');
    const sibling = await authenticatedRequest('patch', `${BASE}/${ramiId}`, asAdmin).send({ studentEmail: 'sami.haddad@example.com' });
    expect(sibling.status).toBe(409);
    expect(sibling.body).toMatchObject({
      code: 'SHARED_WITH_STUDENT', message: 'Same address as Sami Haddad (Grade 5). Each student needs their own.',
    });
    expect((await pool.query(`SELECT student_email FROM students WHERE student_id = $1`, [ramiId])).rows[0].student_email).toBeNull();

    // An account's sign-in address cannot be blanked.
    expect((await authenticatedRequest('patch', `${BASE}/${amalId}`, asAdmin).send({ studentEmail: '' })).status).toBe(400);

    // A login never moves onto a parent's address on file.
    await pool.query(`UPDATE students SET father_email = 'Dad.Inbox@example.com' WHERE student_id = $1`, [amalId]);
    const family = await authenticatedRequest('patch', `${BASE}/${amalId}`, asAdmin).send({ studentEmail: 'dad.inbox@example.com' });
    expect(family.status).toBe(409);
    expect(family.body).toMatchObject({
      code: 'FAMILY_ADDRESS', message: "This is a parent's address on file. Use the student's own school address.",
    });
    expect((await userOf(amalId)).email).toBe('amal.h@example.com');

    // Another school's admin cannot see this student.
    await pool.query(`INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT DO NOTHING`);
    const foreign = await authenticatedRequest('patch', `${BASE}/${amalId}`, { ...asAdmin, userId: '550e8400-e29b-41d4-a716-446655440099', school: 'PLAYGROUND' })
      .send({ studentEmail: 'x@example.com' });
    expect(foreign.status).toBe(404);
  });

  // 7
  it('resend-invite is 400 for an active account; reset-password is 400 for an invited one', async () => {
    await invite([amalId, samiId]);
    const sami = await activate(samiId);
    const amal = await userOf(amalId);
    mockSend.mockClear();

    expect((await authenticatedRequest('post', `${BASE}/${samiId}/resend-invite`, asAdmin)).status).toBe(400);
    expect((await authenticatedRequest('post', `${BASE}/${amalId}/reset-password`, asAdmin)).status).toBe(400);
    expect((await authenticatedRequest('post', `${BASE}/${ramiId}/resend-invite`, asAdmin)).status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();

    const resend = await authenticatedRequest('post', `${BASE}/${amalId}/resend-invite`, asAdmin);
    expect(resend.status).toBe(200);
    expect(resend.body.data).toEqual({ sent: true });
    const { rows: amalInvites } = await pool.query(
      `SELECT end_reason FROM student_invites WHERE user_id = $1 ORDER BY created_at`, [amal.user_id],
    );
    expect(amalInvites).toEqual([{ end_reason: 'replaced' }, { end_reason: null }]);
    expect(mockSend.mock.calls[0][0]).toMatchObject({ to: 'amal.haddad@example.com', subject: 'Set up your Al Haadi Academy SchoolMule account' });

    const reset = await authenticatedRequest('post', `${BASE}/${samiId}/reset-password`, asAdmin);
    expect(reset.status).toBe(200);
    expect(reset.body.data).toEqual({ sent: true });
    const { rows: samiTokens } = await pool.query(
      `SELECT token, expires_at > NOW() + interval '6 days' AS long_lived FROM password_reset_tokens WHERE user_id = $1`,
      [sami.user_id],
    );
    expect(samiTokens).toHaveLength(1);
    expect(samiTokens[0].long_lived).toBe(true);
    const resetMail = mockSend.mock.calls[1][0];
    expect(resetMail).toMatchObject({ to: 'sami.haddad@example.com', subject: 'Reset your SchoolMule password' });
    expect(resetMail.html).toContain('Office Admin asked for a new password link for your account.');
    expect(resetMail.html).toContain(`/reset-password?token=${samiTokens[0].token}&amp;next=%2Fstudent`);
  });

  // 8
  it('archive sets is_archived and voids the QR; unarchive restores', async () => {
    await invite([amalId]);
    const amal = await userOf(amalId);
    await pool.query(`UPDATE student_accounts SET qr_secret_hash = 'qr-hash', qr_issued_at = NOW() WHERE user_id = $1`, [amal.user_id]);
    expect(rowOf(await list(), amalId).account.qr.active).toBe(true);

    const archived = await authenticatedRequest('post', `${BASE}/${amalId}/archive`, asAdmin);
    expect(archived.status).toBe(200);
    expect(archived.body.data).toMatchObject({ status: 'archived', qrEligible: false, account: { qr: { active: false } } });
    expect(archived.body.data.account.qr.voidedAt).toEqual(expect.any(String));

    const { rows: [u] } = await pool.query(`SELECT * FROM users WHERE user_id = $1`, [amal.user_id]);
    expect(u).toMatchObject({ is_archived: true, archived_by: ADMIN_ID });
    expect(u.archived_at).toBeInstanceOf(Date);
    expect((await pool.query(`SELECT 1 FROM password_reset_tokens WHERE user_id = $1`, [amal.user_id])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT qr_voided_at FROM student_accounts WHERE user_id = $1`, [amal.user_id])).rows[0].qr_voided_at)
      .toBeInstanceOf(Date);

    expect((await authenticatedRequest('post', `${BASE}/${amalId}/archive`, asAdmin)).status).toBe(409);

    const restored = await authenticatedRequest('post', `${BASE}/${amalId}/unarchive`, asAdmin);
    expect(restored.status).toBe(200);
    expect(restored.body.data).toMatchObject({ status: 'invited', account: { qr: { active: false } } });
    const { rows: [back] } = await pool.query(`SELECT * FROM users WHERE user_id = $1`, [amal.user_id]);
    expect(back).toMatchObject({ is_archived: false, archived_at: null, archived_by: null, is_verified_school: true });

    expect((await authenticatedRequest('post', `${BASE}/${amalId}/unarchive`, asAdmin)).status).toBe(409);
    expect((await authenticatedRequest('post', `${BASE}/${ramiId}/archive`, asAdmin)).status).toBe(400);
  });

  // 9
  it('relink: link an unlinked student user to a current-year row; 409 when already linked this year', async () => {
    const { rows: [lastYear] } = await pool.query(
      `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
       SELECT 'ALHAADIACADEMY', school_id, '2024-2025', DATE '2024-09-01', DATE '2025-06-30', FALSE
         FROM schools WHERE school_code = 'ALHAADIACADEMY'
       RETURNING school_year_id`,
    );
    const lastYearAmal = await student('Amal Haddad', '1', { yearId: lastYear.school_year_id, studentEmail: 'amal.haddad@example.com' });
    // Last year's account, linked to last year's row only.
    const amalUserId = asStudent.userId;
    await user(amalUserId, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT');
    // A real login always has its consent record (an invite writes it).
    await pool.query(
      `INSERT INTO student_accounts (user_id, school, consent_at, consent_notice_version) VALUES ($1, 'ALHAADIACADEMY', NOW(), '2026-10')`,
      [amalUserId],
    );
    await pool.query(
      `INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`,
      [amalUserId, lastYearAmal, lastYear.school_year_id],
    );
    await setEmail(amalId, null);

    const unlinked = await authenticatedRequest('get', `${BASE}/unlinked`, asAdmin);
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.data).toEqual([
      { userId: amalUserId, name: 'Amal Haddad', email: 'amal.haddad@example.com', lastSchoolYearLabel: '2024-2025' },
    ]);

    const linked = await authenticatedRequest('post', `${BASE}/${amalId}/link`, asAdmin).send({ userId: amalUserId });
    expect(linked.status).toBe(200);
    expect(linked.body.data).toMatchObject({ studentId: amalId, status: 'active', account: { userId: amalUserId } });
    // A blank student email takes the account's address.
    expect(linked.body.data.studentEmail).toBe('amal.haddad@example.com');
    const { rows: links } = await pool.query(
      `SELECT student_id, school_year_id, linked_by FROM student_account_links WHERE user_id = $1 ORDER BY created_at`, [amalUserId],
    );
    expect(links).toHaveLength(2);
    expect(links[1]).toEqual({ student_id: amalId, school_year_id: yearId, linked_by: ADMIN_ID });
    expect((await authenticatedRequest('get', `${BASE}/unlinked`, asAdmin)).body.data).toEqual([]);

    // That login already has a row this year.
    const again = await authenticatedRequest('post', `${BASE}/${ramiId}/link`, asAdmin).send({ userId: amalUserId });
    expect(again.status).toBe(409);

    // The student already has a login.
    const otherId = '550e8400-e29b-41d4-a716-446655440011';
    await user(otherId, 'other.student@example.com', 'Other', 'Student', 'STUDENT');
    const taken = await authenticatedRequest('post', `${BASE}/${amalId}/link`, asAdmin).send({ userId: otherId });
    expect(taken.status).toBe(409);

    // Only student logins of this school can be linked.
    expect((await authenticatedRequest('post', `${BASE}/${ramiId}/link`, asAdmin).send({ userId: MOTHER_ID })).status).toBe(404);

    const unlink = await authenticatedRequest('delete', `${BASE}/${amalId}/link`, asAdmin);
    expect(unlink.status).toBe(200);
    expect(unlink.body.data).toMatchObject({ studentId: amalId, status: 'not_invited', account: null });
    expect((await pool.query(`SELECT 1 FROM users WHERE user_id = $1`, [amalUserId])).rows).toHaveLength(1);
    expect((await pool.query(`SELECT 1 FROM student_account_links WHERE student_id = $1`, [amalId])).rows).toHaveLength(0);
    expect((await authenticatedRequest('delete', `${BASE}/${amalId}/link`, asAdmin)).status).toBe(404);
  });

  // 10
  it('delete account is 409 while active, 200 after archive', async () => {
    await invite([amalId]);
    const amal = await activate(amalId);

    const blocked = await authenticatedRequest('delete', `${BASE}/${amalId}/account`, asAdmin);
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toBe('Archive the account first');

    expect((await authenticatedRequest('post', `${BASE}/${amalId}/archive`, asAdmin)).status).toBe(200);
    const done = await authenticatedRequest('delete', `${BASE}/${amalId}/account`, asAdmin);
    expect(done.status).toBe(200);
    expect(done.body.data).toEqual({ deleted: true });

    expect((await pool.query(`SELECT 1 FROM users WHERE user_id = $1`, [amal.user_id])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT 1 FROM student_accounts WHERE user_id = $1`, [amal.user_id])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT 1 FROM student_account_links WHERE user_id = $1`, [amal.user_id])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT 1 FROM students WHERE student_id = $1`, [amalId])).rows).toHaveLength(1);
    expect(rowOf(await list(), amalId).status).toBe('not_invited');
    expect((await authenticatedRequest('delete', `${BASE}/${amalId}/account`, asAdmin)).status).toBe(404);
  });

  // 11
  it('teacher and parent tokens get 403 on /api/admin/student-accounts and /api/admin/classroom-settings', async () => {
    for (const who of [asTeacher, asParent]) {
      expect((await authenticatedRequest('get', BASE, who)).status).toBe(403);
      expect((await authenticatedRequest('post', `${BASE}/invite`, who).send({ studentIds: [amalId], consentConfirmed: true })).status).toBe(403);
      expect((await authenticatedRequest('get', '/api/admin/classroom-settings', who)).status).toBe(403);
      expect((await authenticatedRequest('put', '/api/admin/classroom-settings', who).send({})).status).toBe(403);
    }
    const fenced = await authenticatedRequest('get', BASE, asStudent);
    expect(fenced.status).toBe(403);
    expect(fenced.body.code).toBe('STUDENT_FORBIDDEN');
    expect((await pool.query(`SELECT 1 FROM users WHERE role::text = 'STUDENT'`)).rows).toHaveLength(0);
  });

  // 12
  it('classroom-settings GET returns defaults with updatedAt null when no row; PUT upserts', async () => {
    await pool.query(`DELETE FROM school_classroom_settings`);

    const defaults = await authenticatedRequest('get', '/api/admin/classroom-settings', asAdmin);
    expect(defaults.status).toBe(200);
    expect(defaults.body.data).toEqual({
      enabled: false, loginFromGrade: '1', qrUntilGrade: '3', studentEmailFromGrade: '1',
      parentsReadPrivateComments: true, summaryDow: 5, parentSummary: false, replyReminders: false, parentNudge: false, studentPhotos: false, consentNoticeVersion: '2026-10',
      studentEmailDomains: [], studentSignIn: 'google_or_password',
      updatedAt: null,
    });

    const body = {
      enabled: true, loginFromGrade: '2', qrUntilGrade: '4', studentEmailFromGrade: null,
      parentsReadPrivateComments: false, summaryDow: 4, studentPhotos: true, consentNoticeVersion: '2026-11',
    };
    const created = await authenticatedRequest('put', '/api/admin/classroom-settings', asAdmin).send(body);
    expect(created.status).toBe(200);
    // main's body (no studentEmailDomains / studentSignIn / parentSummary) still saves, keeping the defaults.
    expect(created.body.data).toEqual({
      ...body, studentEmailDomains: [], studentSignIn: 'google_or_password', parentSummary: false, replyReminders: false, parentNudge: false, updatedAt: expect.any(String),
    });
    const { rows: [row] } = await pool.query(`SELECT * FROM school_classroom_settings WHERE school = 'ALHAADIACADEMY'`);
    expect(row).toMatchObject({ enabled: true, login_from_grade: '2', student_email_from_grade: null, updated_by: ADMIN_ID });

    const updated = await authenticatedRequest('put', '/api/admin/classroom-settings', asAdmin)
      .send({ ...body, loginFromGrade: 'SK', studentEmailFromGrade: '3' });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ loginFromGrade: 'SK', studentEmailFromGrade: '3' });
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM school_classroom_settings`)).rows[0].n).toBe(1);

    const read = await authenticatedRequest('get', '/api/admin/classroom-settings', asAdmin);
    expect(read.body.data).toEqual(updated.body.data);

    // The list uses the saved settings: SK now gets logins.
    expect(rowOf(await list(), linaId).status).toBe('not_invited');

    const bad = await authenticatedRequest('put', '/api/admin/classroom-settings', asAdmin).send({ ...body, summaryDow: 9 });
    expect(bad.status).toBe(400);

    // The parents' summary is its own switch: on with the student portal off, and kept by a save that leaves it out.
    const summaryOn = await authenticatedRequest('put', '/api/admin/classroom-settings', asAdmin).send({ ...body, enabled: false, parentSummary: true });
    expect(summaryOn.body.data).toMatchObject({ enabled: false, parentSummary: true });
    const kept = await authenticatedRequest('put', '/api/admin/classroom-settings', asAdmin).send({ ...body, enabled: false });
    expect(kept.body.data.parentSummary).toBe(true);
    // The consent notice version isn't shown any more: a save without it keeps the saved one.
    const { consentNoticeVersion, ...noVersion } = body;
    const versionKept = await authenticatedRequest('put', '/api/admin/classroom-settings', asAdmin).send(noVersion);
    expect(versionKept.body.data.consentNoticeVersion).toBe(consentNoticeVersion);
  });

  it('classroom-settings round-trips the student email domains and sign-in mode, and a later save without them keeps them', async () => {
    const body = {
      enabled: true, loginFromGrade: '1', qrUntilGrade: '3', studentEmailFromGrade: '1',
      parentsReadPrivateComments: true, summaryDow: 5, studentPhotos: false, consentNoticeVersion: '2026-10',
    };
    const saved = await authenticatedRequest('put', '/api/admin/classroom-settings', asAdmin)
      .send({ ...body, studentEmailDomains: ['Students.Example.org'], studentSignIn: 'google_only' });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ studentEmailDomains: ['students.example.org'], studentSignIn: 'google_only' });
    const { rows: [row] } = await pool.query(`SELECT student_email_domains, student_sign_in FROM school_classroom_settings`);
    expect(row).toEqual({ student_email_domains: ['students.example.org'], student_sign_in: 'google_only' });

    const mainSave = await authenticatedRequest('put', '/api/admin/classroom-settings', asAdmin).send({ ...body, summaryDow: 3 });
    expect(mainSave.status).toBe(200);
    expect(mainSave.body.data).toMatchObject({ summaryDow: 3, studentEmailDomains: ['students.example.org'], studentSignIn: 'google_only' });
  });

  // 13
  it('PATCH /api/students/:id stores studentEmail lowercased; 409 when an account exists with a different email', async () => {
    const res = await authenticatedRequest('patch', `/api/students/${ramiId}`, asAdmin).send({ studentEmail: ' Rami.Haddad@Example.com ' });
    expect(res.status).toBe(200);
    expect(res.body.data.studentEmail).toBe('rami.haddad@example.com');
    expect((await pool.query(`SELECT student_email FROM students WHERE student_id = $1`, [ramiId])).rows[0].student_email)
      .toBe('rami.haddad@example.com');

    // A PATCH that does not carry studentEmail leaves it alone.
    const rename = await authenticatedRequest('patch', `/api/students/${ramiId}`, asAdmin).send({ name: 'Rami K. Haddad' });
    expect(rename.status).toBe(200);
    expect(rename.body.data.studentEmail).toBe('rami.haddad@example.com');
    expect((await authenticatedRequest('get', `/api/students/${ramiId}`, asAdmin)).body.data.studentEmail).toBe('rami.haddad@example.com');

    await invite([amalId]);
    const blocked = await authenticatedRequest('patch', `/api/students/${amalId}`, asAdmin).send({ studentEmail: 'amal.new@example.com' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toBe('This student has a SchoolMule account. Change the email on Admin Panel → Student accounts.');
    expect((await pool.query(`SELECT student_email FROM students WHERE student_id = $1`, [amalId])).rows[0].student_email)
      .toBe('Amal.Haddad@Example.com');

    // The same address (any case) is not a change.
    const same = await authenticatedRequest('patch', `/api/students/${amalId}`, asAdmin).send({ studentEmail: 'AMAL.HADDAD@example.com' });
    expect(same.status).toBe(200);
    expect(same.body.data.studentEmail).toBe('amal.haddad@example.com');

    expect((await authenticatedRequest('patch', `/api/students/${ramiId}`, asAdmin).send({ studentEmail: 'not-an-email' })).status).toBe(400);

    const created = await authenticatedRequest('post', '/api/students', asAdmin)
      .send({ name: 'Dalia Haddad', grade: '3', studentEmail: 'Dalia.Haddad@Example.com' });
    expect(created.status).toBe(201);
    expect(created.body.data.studentEmail).toBe('dalia.haddad@example.com');
  });

  it('M1: a student login is never offered as a parent, and linking one is refused', async () => {
    await invite([amalId]);
    const login = await userOf(amalId);
    const picker = await authenticatedRequest('get', '/api/parents', asAdmin);
    expect(picker.status).toBe(200);
    const ids = (picker.body.data || []).map((p) => p.userId ?? p.user_id);
    expect(ids).toContain(MOTHER_ID);
    expect(ids).not.toContain(login.user_id);
    const link = await authenticatedRequest('post', '/api/parent-students', asAdmin)
      .send({ studentId: ramiId, parentId: login.user_id, relation: 'Sibling' });
    expect(link.status).toBe(400);
    expect((await pool.query(`SELECT 1 FROM parent_students WHERE parent_id = $1`, [login.user_id])).rows).toEqual([]);
  });

  it("M6: /api/students shows a student's own address to admins only", async () => {
    const admin = await authenticatedRequest('get', `/api/students/${amalId}`, asAdmin);
    expect(admin.status).toBe(200);
    expect(admin.body.data.studentEmail).toBe('Amal.Haddad@Example.com');
    expect((await authenticatedRequest('get', '/api/students', asAdmin)).body.data.find((x) => x.studentId === amalId).studentEmail)
      .toBe('Amal.Haddad@Example.com');
    const one = await authenticatedRequest('get', `/api/students/${amalId}`, asTeacher);
    expect(one.status).toBe(200);
    expect(one.body.data).not.toHaveProperty('studentEmail');
    const all = await authenticatedRequest('get', '/api/students', asTeacher);
    expect(JSON.stringify(all.body)).not.toMatch(/amal\.haddad@example\.com/i);
    // A parent never reads the roster here at all (R1: /api/students is staff only).
    expect((await authenticatedRequest('get', `/api/students/${amalId}`, asParent)).status).toBe(403);
    expect((await authenticatedRequest('get', '/api/students', asParent)).status).toBe(403);
  });

  it("only an admin of the student's school can set a student email on the student form", async () => {
    const studentEmailOf = async (id) =>
      (await pool.query(`SELECT student_email FROM students WHERE student_id = $1`, [id])).rows[0].student_email;

    const refused = await authenticatedRequest('patch', `/api/students/${ramiId}`, asTeacher).send({ studentEmail: 'taken.over@example.com' });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe("Only people who manage student accounts can set a student's email. Use Admin Panel → Student accounts.");
    // Clearing it is a change too.
    expect((await authenticatedRequest('patch', `/api/students/${amalId}`, asTeacher).send({ studentEmail: null })).status).toBe(403);
    // A parent is refused before any of that (R1: staff only).
    expect((await authenticatedRequest('patch', `/api/students/${ramiId}`, asParent).send({ studentEmail: 'taken.over@example.com' })).status).toBe(403);
    expect(await studentEmailOf(ramiId)).toBeNull();
    expect(await studentEmailOf(amalId)).toBe('Amal.Haddad@Example.com');

    // The rest of the form still works for a teacher.
    const rename = await authenticatedRequest('patch', `/api/students/${ramiId}`, asTeacher).send({ name: 'Rami K. Haddad' });
    expect(rename.status).toBe(200);
    expect(rename.body.data).not.toHaveProperty('studentEmail'); // admins only (M6)
    expect(await studentEmailOf(ramiId)).toBeNull();

    const created = await authenticatedRequest('post', '/api/students', asTeacher)
      .send({ name: 'Dalia Haddad', grade: '3', studentEmail: 'taken.over@example.com' });
    expect(created.status).toBe(403);
    expect((await pool.query(`SELECT 1 FROM students WHERE name = 'Dalia Haddad'`)).rows).toHaveLength(0);

    // Another school's admin cannot reach this school's student.
    await pool.query(`INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT DO NOTHING`);
    const foreign = await authenticatedRequest('patch', `/api/students/${ramiId}`, { ...asAdmin, userId: '550e8400-e29b-41d4-a716-446655440099', school: 'PLAYGROUND' })
      .send({ studentEmail: 'taken.over@example.com' });
    expect(foreign.status).toBe(404);
    expect(await studentEmailOf(ramiId)).toBeNull();

    // No invite can go to an address a non-admin typed.
    const res = await invite([ramiId]);
    expect(res.body.data.results[0]).toMatchObject({ outcome: 'skipped', reason: 'no_email' });
  });

  it('the registration import offers and saves a student email mapping', async () => {
    const { rows: [form] } = await pool.query(
      `INSERT INTO registration_forms (school, title, slug, created_by) VALUES ('ALHAADIACADEMY', 'Enrolment', 'enrolment', $1) RETURNING form_id`,
      [ADMIN_ID],
    );
    const { rows: [field] } = await pool.query(
      `INSERT INTO registration_form_fields (form_id, field_type, label) VALUES ($1, 'email', 'Student email address') RETURNING field_id`,
      [form.form_id],
    );

    const suggested = await authenticatedRequest('get', `/api/registration/forms/${form.form_id}/import/mapping`, asAdmin);
    expect(suggested.status).toBe(200);
    expect(suggested.body.data.mappings).toEqual([expect.objectContaining({ fieldId: field.field_id, targetField: 'studentEmail' })]);
    expect(suggested.body.data.targetFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetField: 'studentEmail', label: 'Student — email' }),
    ]));

    const saved = await authenticatedRequest('put', `/api/registration/forms/${form.form_id}/import/mapping`, asAdmin)
      .send({ mappings: [{ fieldId: field.field_id, targetField: 'studentEmail', valueMap: null }] });
    expect(saved.status).toBe(200);
    expect(saved.body.data.mappings[0].targetField).toBe('studentEmail');
  });

  describe('address checks and invite state on each row (student invitations, Task 3)', () => {
    // A login as an invite leaves it: the placeholder password, a consent
    // record, this year's link and (optionally) one invite row.
    const seedLogin = async (studentId, email, { inviteRow = { send_status: 'sent', expiresIn: '14 days' } } = {}) => {
      const { rows: [u] } = await pool.query(
        `INSERT INTO users (email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ($1, 'Seeded Student', '!', 'Seeded', 'Student', 'ALHAADIACADEMY', 'STUDENT', true, true) RETURNING user_id`, [email],
      );
      await pool.query(`INSERT INTO student_accounts (user_id, school, consent_by, consent_at, consent_notice_version, created_by)
                        VALUES ($1, 'ALHAADIACADEMY', $2, NOW(), '2026-10', $2)`, [u.user_id, ADMIN_ID]);
      await pool.query(`INSERT INTO student_account_links (user_id, student_id, school_year_id, linked_by) VALUES ($1, $2, $3, $4)`,
        [u.user_id, studentId, yearId, ADMIN_ID]);
      if (inviteRow) {
        await pool.query(
          `INSERT INTO student_invites (school, user_id, student_id, school_year_id, email, token_hash, expires_at, send_status, sent_at)
           VALUES ('ALHAADIACADEMY', $1, $2, $3, $4, md5(random()::text), NOW() + $5::interval, $6, NOW())`,
          [u.user_id, studentId, yearId, email, inviteRow.expiresIn, inviteRow.send_status],
        );
      }
      return u.user_id;
    };
    it('two students of one year with one address are both flagged, each naming the other', async () => {
      await setEmail(ramiId, 'amal.haddad@example.com');
      const data = await list();
      expect(rowOf(data, amalId).conflict).toEqual({
        kind: 'shared_with_student', message: 'Same address as Rami Haddad (Grade 2). Each student needs their own.',
      });
      expect(rowOf(data, ramiId).conflict).toEqual({
        kind: 'shared_with_student', message: 'Same address as Amal Haddad (Grade 2). Each student needs their own.',
      });
      // Last year's row of the same child is not a sibling.
      const lastYear = (await pool.query(
        `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
         SELECT school, school_id, '2024-2025', '2024-09-01', '2025-06-30', false FROM school_years WHERE school_year_id = $1
         RETURNING school_year_id`, [yearId],
      )).rows[0].school_year_id;
      const samiLastYear = await student('Sami Haddad', '4', { yearId: lastYear, studentEmail: 'sami.haddad@example.com' });
      expect(samiLastYear).toBeTruthy();
      expect(rowOf(await list(), samiId).conflict).toBeNull();
    });

    it("names the role of an account in this school, and never the role of another school's account (R12)", async () => {
      await setEmail(ramiId, 'mona.haddad@example.com');
      expect(rowOf(await list(), ramiId).conflict).toEqual({
        kind: 'email_in_use', message: 'Already used by a parent account in this school. Each student needs their own address.',
      });
      await pool.query(`INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT DO NOTHING`);
      await pool.query(
        `INSERT INTO users (email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ('elsewhere@example.com', 'Elsewhere Teacher', 'x', 'Elsewhere', 'Teacher', 'PLAYGROUND', 'TEACHER', true, true)`,
      );
      await setEmail(ramiId, 'elsewhere@example.com');
      expect(rowOf(await list(), ramiId).conflict).toEqual({
        kind: 'email_in_use', message: 'Already used by another SchoolMule account.',
      });
    });

    it('rows carry warnings for an address outside the school domain or not mentioning the student', async () => {
      await pool.query(`UPDATE school_classroom_settings SET student_email_domains = '{students.example.org}'`);
      await setEmail(ramiId, 'zaid.m@students.example.org');
      const data = await list();
      expect(rowOf(data, amalId).warnings).toEqual([
        { code: 'outside_domain', message: 'Not a school address (students.example.org)' },
      ]);
      expect(rowOf(data, ramiId).warnings).toEqual([
        { code: 'name_mismatch', message: "This address doesn't mention Rami or Haddad" },
      ]);
      expect(rowOf(data, linaId).warnings).toEqual([]);
    });

    it('an invited login with no invite row, or an expired or failed one, needs attention; ?status=needs_attention lists them', async () => {
      await seedLogin(amalId, 'amal.haddad@example.com');
      await seedLogin(samiId, 'sami.haddad@example.com');
      await seedLogin(ramiId, 'rami.haddad@example.com', { inviteRow: { send_status: 'failed', expiresIn: '14 days' } });
      await seedLogin(linaId, 'lina.haddad@example.com', { inviteRow: null });
      await pool.query(`UPDATE school_classroom_settings SET login_from_grade = 'SK'`);
      const fresh = await list();
      expect(rowOf(fresh, amalId)).toMatchObject({ status: 'invited', needsAttention: false, signInMethod: null });
      expect(rowOf(fresh, amalId).invite).toMatchObject({ state: 'pending', expiresAt: expect.any(String), sentAt: expect.any(String) });
      expect(rowOf(fresh, ramiId)).toMatchObject({ needsAttention: true, invite: { state: 'failed' } });
      expect(rowOf(fresh, linaId)).toMatchObject({ status: 'invited', needsAttention: true, invite: null });

      await pool.query(
        `UPDATE student_invites SET expires_at = NOW() - interval '1 minute'
          WHERE user_id = (SELECT user_id FROM student_account_links WHERE student_id = $1)`, [amalId],
      );
      const later = await list();
      expect(rowOf(later, amalId)).toMatchObject({ needsAttention: true, invite: { state: 'expired' } });
      expect(rowOf(later, samiId).needsAttention).toBe(false);
      const attention = await list('?status=needs_attention');
      expect(attention.students.map((r) => r.studentId).sort()).toEqual([amalId, ramiId, linaId].sort());
    });

    it('a login activated by its QR card is active with sign-in method card, even with the invite placeholder password', async () => {
      const userId = await seedLogin(amalId, 'amal.haddad@example.com');
      await pool.query(`UPDATE student_accounts SET activated_at = NOW(), activated_via = 'card' WHERE user_id = $1`, [userId]);
      expect(rowOf(await list(), amalId)).toMatchObject({ status: 'active', signInMethod: 'card', needsAttention: false });
      // Promoted past the card grades (Grade 4 with cards up to Grade 3): it needs attention.
      await pool.query(`UPDATE students SET grade = '4' WHERE student_id = $1`, [amalId]);
      expect(rowOf(await list(), amalId)).toMatchObject({ status: 'active', signInMethod: 'card', needsAttention: true });
      // A password set later makes it a password login.
      await activate(amalId);
      expect(rowOf(await list(), amalId)).toMatchObject({ signInMethod: 'password', needsAttention: false });
    });

    it('?classId= keeps only the class roster, and refuses a malformed id', async () => {
      const { rows: [c] } = await pool.query(
        `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
         VALUES ('ALHAADIACADEMY', '2', 'Math', 'Ziad Teacher', $1, $2) RETURNING class_id`, [TEACHER_ID, yearId],
      );
      await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2), ($1, $3)`, [c.class_id, amalId, ramiId]);
      const data = await list(`?classId=${c.class_id}`);
      expect(data.students.map((r) => r.studentId).sort()).toEqual([amalId, ramiId].sort());
      expect((await authenticatedRequest('get', `${BASE}?classId=nope`, asAdmin)).status).toBe(400);
    });
  });

  describe('relinking (student invitations, Task 6)', () => {
    const nextYearRow = async (fromId, name, grade) => {
      const next = (await pool.query(
        `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
         SELECT school, school_id, '2026-2027', '2026-09-01', '2027-06-30', false FROM school_years WHERE school_year_id = $1
         ON CONFLICT DO NOTHING RETURNING school_year_id`, [yearId],
      )).rows[0]?.school_year_id
        ?? (await pool.query(`SELECT school_year_id FROM school_years WHERE label = '2026-2027'`)).rows[0].school_year_id;
      const id = (await pool.query(
        `INSERT INTO students (name, grade, school, school_year_id, previous_student_id)
         VALUES ($1, $2, 'ALHAADIACADEMY', $3, $4) RETURNING student_id`, [name, grade, next, fromId],
      )).rows[0].student_id;
      return { id, yearId: next };
    };

    it('link refuses a login with no consent record', async () => {
      const { rows: [u] } = await pool.query(
        `INSERT INTO users (email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ('orphan@example.com', 'Orphan Login', '!', 'Orphan', 'Login', 'ALHAADIACADEMY', 'STUDENT', true, true) RETURNING user_id`,
      );
      const res = await authenticatedRequest('post', `${BASE}/${ramiId}/link`, asAdmin).send({ userId: u.user_id });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('This login has no consent record. Invite the student instead.');
    });

    it("link and unlink follow the student's already-rolled later rows", async () => {
      await invite([amalId]);
      const login = await userOf(amalId);
      await authenticatedRequest('delete', `${BASE}/${amalId}/link`, asAdmin);
      const later = await nextYearRow(amalId, 'Amal Haddad', '3');

      const linked = await authenticatedRequest('post', `${BASE}/${amalId}/link`, asAdmin).send({ userId: login.user_id });
      expect(linked.status).toBe(200);
      const links = async () => (await pool.query(
        `SELECT student_id FROM student_account_links WHERE user_id = $1 ORDER BY student_id`, [login.user_id],
      )).rows.map((r) => r.student_id).sort();
      expect(await links()).toEqual([amalId, later.id].sort());

      await authenticatedRequest('delete', `${BASE}/${amalId}/link`, asAdmin);
      expect(await links()).toEqual([]);
    });
  });
});