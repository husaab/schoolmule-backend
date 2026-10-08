const mockSend = jest.fn().mockResolvedValue({});
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: (...args) => mockSend(...args) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const PENDING_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440011';
const PENDING_PARENT_ID = '550e8400-e29b-41d4-a716-446655440012';
const APPROVED_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440013';
const UNVERIFIED_ID = '550e8400-e29b-41d4-a716-446655440014';
const OTHER_SCHOOL_PENDING_ID = '550e8400-e29b-41d4-a716-446655440019';

// Synthetic identities only — never real parents or students.
const insertUser = (pool, { id, email, first, last, school = 'ALHAADIACADEMY', role, verified = true, approved = false }) =>
  pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, $6, $7, $8, $9)`,
    [id, email, `${first} ${last}`, first, last, school, role, verified, approved]
  );

const insertStudent = async (pool, { name, grade = '3', school = 'ALHAADIACADEMY', yearId, motherEmail = null, fatherEmail = null, archived = false }) => {
  const { rows } = await pool.query(
    `INSERT INTO students (name, school, grade, school_year_id, mother_email, father_email, is_archived)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING student_id`,
    [name, school, grade, yearId, motherEmail, fatherEmail, archived]
  );
  return rows[0].student_id;
};

const userRow = async (pool, id) => (await pool.query('SELECT * FROM users WHERE user_id = $1', [id])).rows[0];

describe('Integration: Admin Approvals Routes', () => {
  let pool, yearId, otherYearId;

  beforeAll(() => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    mockSend.mockClear();
    mockSend.mockResolvedValue({});

    await pool.query(`INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT DO NOTHING`);

    await insertUser(pool, { id: ADMIN_ID, email: 'admin@test.com', first: 'Admin', last: 'User', role: 'ADMIN', approved: true });
    await insertUser(pool, { id: PENDING_TEACHER_ID, email: 'pending.teacher@test.com', first: 'Tina', last: 'Pending', role: 'TEACHER' });
    await insertUser(pool, { id: PENDING_PARENT_ID, email: 'Pending.Parent@test.com', first: 'Paula', last: 'Pending', role: 'PARENT' });
    await insertUser(pool, { id: APPROVED_TEACHER_ID, email: 'approved@test.com', first: 'Al', last: 'Approved', role: 'TEACHER', approved: true });
    await insertUser(pool, { id: UNVERIFIED_ID, email: 'unverified@test.com', first: 'Una', last: 'Unverified', role: 'PARENT', verified: false });
    await insertUser(pool, { id: OTHER_SCHOOL_PENDING_ID, email: 'other@test.com', first: 'Olly', last: 'Other', school: 'PLAYGROUND', role: 'TEACHER' });

    yearId = (await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active`)).rows[0].school_year_id;
    otherYearId = (await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'PLAYGROUND' AND is_active`)).rows[0].school_year_id;
  });

  describe('GET /api/admin/approvals', () => {
    it('lists pending signups for the admin school only, with children on file', async () => {
      const kid = await insertStudent(pool, { name: 'Kid Listed', yearId, motherEmail: 'pending.parent@test.com' });
      await insertStudent(pool, { name: 'Kid Elsewhere', school: 'PLAYGROUND', yearId: otherYearId, motherEmail: 'pending.parent@test.com' });
      const res = await authenticatedRequest('get', '/api/admin/approvals');

      const parent = res.body.data.find((u) => u.userId === PENDING_PARENT_ID);
      expect(parent.matchedChildren).toEqual([expect.objectContaining({ studentId: kid, name: 'Kid Listed', grade: '3' })]);
      expect(res.body.data.find((u) => u.userId === PENDING_TEACHER_ID).matchedChildren).toEqual([]);

      expect(res.status).toBe(200);
      const ids = res.body.data.map((u) => u.userId);
      expect(ids).toEqual(expect.arrayContaining([PENDING_TEACHER_ID, PENDING_PARENT_ID]));
      expect(ids).not.toContain(APPROVED_TEACHER_ID);
      expect(ids).not.toContain(UNVERIFIED_ID);
      expect(ids).not.toContain(OTHER_SCHOOL_PENDING_ID);
      expect(res.body.data[0]).not.toHaveProperty('password');
    });

    it('includes declined signups but not staff archived from the Users page', async () => {
      await authenticatedRequest('post', `/api/admin/approvals/${PENDING_TEACHER_ID}/decline`).send({ sendEmail: false });
      await pool.query(
        `UPDATE users SET is_archived = true, archived_at = NOW(), is_verified_school = false WHERE user_id = $1`,
        [APPROVED_TEACHER_ID]
      );

      const res = await authenticatedRequest('get', '/api/admin/approvals');
      const declined = res.body.data.find((u) => u.userId === PENDING_TEACHER_ID);
      expect(declined).toMatchObject({ isArchived: true });
      expect(declined.declinedAt).toBeTruthy();
      expect(res.body.data.map((u) => u.userId)).not.toContain(APPROVED_TEACHER_ID);
    });

    it('rejects non-admins', async () => {
      const res = await authenticatedRequest('get', '/api/admin/approvals', { userId: APPROVED_TEACHER_ID, role: 'TEACHER' });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/admin/approvals/:id/children', () => {
    it('suggests active-year students whose family email matches, case-insensitively', async () => {
      const motherMatch = await insertStudent(pool, { name: 'Kid Mother', yearId, motherEmail: 'pending.parent@test.com' });
      const fatherMatch = await insertStudent(pool, { name: 'Kid Father', yearId, fatherEmail: 'PENDING.PARENT@TEST.COM' });
      const unrelated = await insertStudent(pool, { name: 'Kid Unrelated', yearId });
      await insertStudent(pool, { name: 'Kid Archived', yearId, motherEmail: 'pending.parent@test.com', archived: true });
      await insertStudent(pool, { name: 'Kid Elsewhere', school: 'PLAYGROUND', yearId: otherYearId, motherEmail: 'pending.parent@test.com' });

      const res = await authenticatedRequest('get', `/api/admin/approvals/${PENDING_PARENT_ID}/children`);

      expect(res.status).toBe(200);
      expect(res.body.data.suggested).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ studentId: motherMatch, relation: 'Mother' }),
          expect.objectContaining({ studentId: fatherMatch, relation: 'Father' }),
        ])
      );
      expect(res.body.data.suggested).toHaveLength(2);
      const allIds = res.body.data.students.map((s) => s.studentId);
      expect(allIds).toEqual(expect.arrayContaining([motherMatch, fatherMatch, unrelated]));
      expect(allIds).toHaveLength(3);
    });

    it('404s for a signup in another school', async () => {
      const res = await authenticatedRequest('get', `/api/admin/approvals/${OTHER_SCHOOL_PENDING_ID}/children`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/admin/approvals/:id/approve', () => {
    it('approves a teacher as-is and emails them', async () => {
      const res = await authenticatedRequest('post', `/api/admin/approvals/${PENDING_TEACHER_ID}/approve`).send({});

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ emailSent: true, linkedCount: 0 });
      expect(res.body.data.user).toMatchObject({ role: 'TEACHER', isVerifiedSchool: true });
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0].to).toBe('pending.teacher@test.com');
      expect(mockSend.mock.calls[0][0].html).toContain('teacher');
    });

    it('fixes the role and links children in one step', async () => {
      const kid = await insertStudent(pool, { name: 'Kid One', yearId, motherEmail: 'pending.teacher@test.com' });
      const kid2 = await insertStudent(pool, { name: 'Kid Two', yearId });

      const res = await authenticatedRequest('post', `/api/admin/approvals/${PENDING_TEACHER_ID}/approve`).send({
        role: 'PARENT',
        children: [
          { studentId: kid, relation: 'Mother' },
          { studentId: kid2, relation: 'Guardian' },
          { studentId: kid2, relation: 'Guardian' }, // duplicate in the request
        ],
      });

      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject({ role: 'PARENT', isVerifiedSchool: true });
      expect(res.body.data.linkedCount).toBe(2);
      expect(mockSend.mock.calls[0][0].html).toContain('parent');
      expect(mockSend.mock.calls[0][0].html).toContain('2 children');

      const { rows } = await pool.query(
        'SELECT student_id, relation, parent_email, school FROM parent_students WHERE parent_id = $1 ORDER BY relation',
        [PENDING_TEACHER_ID]
      );
      expect(rows).toEqual([
        expect.objectContaining({ student_id: kid2, relation: 'Guardian', parent_email: 'pending.teacher@test.com', school: 'ALHAADIACADEMY' }),
        expect.objectContaining({ student_id: kid, relation: 'Mother' }),
      ]);
    });

    it('can correct the name on the way in, and the email greets the new name', async () => {
      const res = await authenticatedRequest('post', `/api/admin/approvals/${PENDING_PARENT_ID}/approve`)
        .send({ firstName: 'Sonia', lastName: 'Example' });

      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject({ firstName: 'Sonia', lastName: 'Example', fullName: 'Sonia Example', isVerifiedSchool: true });
      expect((await userRow(getTestPool(), PENDING_PARENT_ID)).username).toBe('Sonia Example');
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0].html).toContain('Sonia');

      const blank = await authenticatedRequest('post', `/api/admin/approvals/${PENDING_TEACHER_ID}/approve`).send({ firstName: '  ' });
      expect(blank.status).toBe(400);
      expect((await userRow(getTestPool(), PENDING_TEACHER_ID)).is_verified_school).toBe(false);
    });

    it('claims a hand-typed contact row for the same email instead of duplicating it', async () => {
      const kid = await insertStudent(pool, { name: 'Kid Claim', yearId });
      await pool.query(
        `INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school)
         VALUES ($1, NULL, 'Paula Pending', 'PENDING.parent@test.com', 'Mother', 'ALHAADIACADEMY')`,
        [kid]
      );

      const res = await authenticatedRequest('post', `/api/admin/approvals/${PENDING_PARENT_ID}/approve`).send({
        children: [{ studentId: kid, relation: 'Guardian' }],
      });

      expect(res.status).toBe(200);
      const { rows } = await pool.query('SELECT parent_id, relation FROM parent_students WHERE student_id = $1', [kid]);
      expect(rows).toEqual([{ parent_id: PENDING_PARENT_ID, relation: 'Mother' }]);
    });

    it('rolls back entirely when a student is not in this school', async () => {
      const foreign = await insertStudent(pool, { name: 'Kid Elsewhere', school: 'PLAYGROUND', yearId: otherYearId });

      const res = await authenticatedRequest('post', `/api/admin/approvals/${PENDING_TEACHER_ID}/approve`).send({
        role: 'PARENT',
        children: [{ studentId: foreign, relation: 'Mother' }],
      });

      expect(res.status).toBe(400);
      const row = await userRow(pool, PENDING_TEACHER_ID);
      expect(row.role).toBe('TEACHER');
      expect(row.is_verified_school).toBe(false);
      expect((await pool.query('SELECT 1 FROM parent_students')).rowCount).toBe(0);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses children for a teacher and refuses ADMIN', async () => {
      const kid = await insertStudent(pool, { name: 'Kid', yearId });
      const withKids = await authenticatedRequest('post', `/api/admin/approvals/${PENDING_TEACHER_ID}/approve`).send({
        children: [{ studentId: kid }],
      });
      expect(withKids.status).toBe(400);

      const asAdmin = await authenticatedRequest('post', `/api/admin/approvals/${PENDING_TEACHER_ID}/approve`).send({ role: 'ADMIN' });
      expect(asAdmin.status).toBe(400);
      expect((await userRow(pool, PENDING_TEACHER_ID)).is_verified_school).toBe(false);
    });

    it('409s when already approved, 404s across schools', async () => {
      const again = await authenticatedRequest('post', `/api/admin/approvals/${APPROVED_TEACHER_ID}/approve`).send({});
      expect(again.status).toBe(409);
      expect(again.body.data).toEqual({ state: 'approved' });

      const other = await authenticatedRequest('post', `/api/admin/approvals/${OTHER_SCHOOL_PENDING_ID}/approve`).send({});
      expect(other.status).toBe(404);
      expect((await userRow(pool, OTHER_SCHOOL_PENDING_ID)).is_verified_school).toBe(false);
    });

    it('still reports success when the email fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('resend down'));

      const res = await authenticatedRequest('post', `/api/admin/approvals/${PENDING_TEACHER_ID}/approve`).send({});

      expect(res.status).toBe(200);
      expect(res.body.data.emailSent).toBe(false);
      expect(res.body.message).toMatch(/could not be sent/);
      expect((await userRow(pool, PENDING_TEACHER_ID)).is_verified_school).toBe(true);
    });
  });

  describe('PATCH /api/admin/approvals/:id/role', () => {
    it('changes the role of a pending signup without approving it', async () => {
      const res = await authenticatedRequest('patch', `/api/admin/approvals/${PENDING_TEACHER_ID}/role`).send({ role: 'PARENT' });

      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject({ role: 'PARENT', isVerifiedSchool: false });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects ADMIN and non-pending users', async () => {
      expect((await authenticatedRequest('patch', `/api/admin/approvals/${PENDING_TEACHER_ID}/role`).send({ role: 'ADMIN' })).status).toBe(400);
      expect((await authenticatedRequest('patch', `/api/admin/approvals/${APPROVED_TEACHER_ID}/role`).send({ role: 'PARENT' })).status).toBe(409);
    });
  });

  describe('PATCH /api/admin/approvals/:id/name', () => {
    it('renames a pending signup and keeps username in step', async () => {
      const res = await authenticatedRequest('patch', `/api/admin/approvals/${PENDING_PARENT_ID}/name`)
        .send({ firstName: '  Parent  ', lastName: 'Renamed' });

      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject({ firstName: 'Parent', lastName: 'Renamed', fullName: 'Parent Renamed', isVerifiedSchool: false });
      const row = await userRow(getTestPool(), PENDING_PARENT_ID);
      expect(row.username).toBe('Parent Renamed');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('allows a single name, requires a first name, and refuses non-pending users', async () => {
      const single = await authenticatedRequest('patch', `/api/admin/approvals/${PENDING_PARENT_ID}/name`).send({ firstName: 'Mononym', lastName: '' });
      expect(single.status).toBe(200);
      expect((await userRow(getTestPool(), PENDING_PARENT_ID)).username).toBe('Mononym');

      expect((await authenticatedRequest('patch', `/api/admin/approvals/${PENDING_PARENT_ID}/name`).send({ firstName: ' ', lastName: 'X' })).status).toBe(400);
      expect((await authenticatedRequest('patch', `/api/admin/approvals/${APPROVED_TEACHER_ID}/name`).send({ firstName: 'A', lastName: 'B' })).status).toBe(409);
      expect((await authenticatedRequest('patch', `/api/admin/approvals/${OTHER_SCHOOL_PENDING_ID}/name`).send({ firstName: 'A', lastName: 'B' })).status).toBe(404);
    });
  });

  describe('POST /api/admin/approvals/:id/decline', () => {
    it('archives, stamps declined_at, emails by default and hides them from the legacy pending list', async () => {
      const res = await authenticatedRequest('post', `/api/admin/approvals/${PENDING_TEACHER_ID}/decline`).send({});

      expect(res.status).toBe(200);
      expect(res.body.data.emailSent).toBe(true);
      const row = await userRow(pool, PENDING_TEACHER_ID);
      expect(row.is_archived).toBe(true);
      expect(row.archived_by).toBe(ADMIN_ID);
      expect(row.declined_at).toBeTruthy();
      expect(row.is_verified_school).toBe(false);

      const legacy = await authenticatedRequest('get', '/api/auth/pending-approvals');
      expect(legacy.body.users.map((u) => u.user_id)).not.toContain(PENDING_TEACHER_ID);
    });

    it('can decline silently', async () => {
      const res = await authenticatedRequest('post', `/api/admin/approvals/${PENDING_TEACHER_ID}/decline`).send({ sendEmail: false });
      expect(res.status).toBe(200);
      expect(res.body.data.emailSent).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('409s for an approved account', async () => {
      const res = await authenticatedRequest('post', `/api/admin/approvals/${APPROVED_TEACHER_ID}/decline`).send({});
      expect(res.status).toBe(409);
      expect((await userRow(pool, APPROVED_TEACHER_ID)).is_archived).toBe(false);
    });
  });

  describe('POST /api/admin/approvals/:id/restore', () => {
    it('returns a declined signup to pending without granting access', async () => {
      await authenticatedRequest('post', `/api/admin/approvals/${PENDING_TEACHER_ID}/decline`).send({ sendEmail: false });

      const res = await authenticatedRequest('post', `/api/admin/approvals/${PENDING_TEACHER_ID}/restore`);

      expect(res.status).toBe(200);
      const row = await userRow(pool, PENDING_TEACHER_ID);
      expect(row).toMatchObject({ is_archived: false, archived_at: null, archived_by: null, declined_at: null, is_verified_school: false });
    });

    it('409s for a signup that is not declined', async () => {
      const res = await authenticatedRequest('post', `/api/admin/approvals/${PENDING_TEACHER_ID}/restore`);
      expect(res.status).toBe(409);
    });
  });

  describe('legacy /api/auth approval routes', () => {
    it('decline-school now persists the decline', async () => {
      const res = await authenticatedRequest('post', '/api/auth/decline-school').send({ userId: PENDING_TEACHER_ID });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect((await userRow(pool, PENDING_TEACHER_ID)).is_archived).toBe(true);
    });

    it('approve-school approves and survives an email failure', async () => {
      mockSend.mockRejectedValueOnce(new Error('resend down'));
      const res = await authenticatedRequest('post', '/api/auth/approve-school').send({ userId: PENDING_TEACHER_ID });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, emailSent: false });
      expect((await userRow(pool, PENDING_TEACHER_ID)).is_verified_school).toBe(true);
    });
  });

  describe('POST /api/auth/register role whitelist', () => {
    it('refuses ADMIN and does not create the account', async () => {
      const res = await require('supertest')(getApp())
        .post('/api/auth/register')
        .send({ username: 'Sneaky Admin', email: 'sneaky@test.com', password: 'password123', school: 'ALHAADIACADEMY', role: 'ADMIN' });

      expect(res.status).toBe(400);
      expect((await pool.query(`SELECT 1 FROM users WHERE email = 'sneaky@test.com'`)).rowCount).toBe(0);
    });

    it('does not leak the email verification token', async () => {
      const res = await require('supertest')(getApp())
        .post('/api/auth/register')
        .send({ username: 'Plain Parent', email: 'plain@test.com', password: 'password123', school: 'ALHAADIACADEMY', role: 'PARENT' });

      expect(res.status).toBe(200);
      expect(res.body.data).not.toHaveProperty('emailToken');
    });
  });
});
