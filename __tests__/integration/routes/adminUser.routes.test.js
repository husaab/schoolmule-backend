jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const PARENT_ID = '550e8400-e29b-41d4-a716-446655440002';
const OTHER_SCHOOL_ID = '550e8400-e29b-41d4-a716-446655440009';

const insertUser = (pool, [id, email, first, last, school, role]) =>
  pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, $6, $7, true, true)`,
    [id, email, `${first} ${last}`, first, last, school, role]
  );

describe('Integration: Admin Users Routes', () => {
  let pool, yearId;

  beforeAll(() => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    await pool.query(`INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT DO NOTHING`);
    await insertUser(pool, [ADMIN_ID, 'admin@test.com', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN']);
    await insertUser(pool, [TEACHER_ID, 'teacher@test.com', 'Tina', 'Teacher', 'ALHAADIACADEMY', 'TEACHER']);
    await insertUser(pool, [PARENT_ID, 'parent@test.com', 'Paul', 'Parent', 'ALHAADIACADEMY', 'PARENT']);
    await insertUser(pool, [OTHER_SCHOOL_ID, 'other@test.com', 'Olly', 'Other', 'PLAYGROUND', 'TEACHER']);

    const { rows } = await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active`
    );
    yearId = rows[0].school_year_id;
  });

  describe('GET /api/admin/users', () => {
    it('lists only users in the admin\'s school', async () => {
      const res = await authenticatedRequest('get', '/api/admin/users');

      expect(res.status).toBe(200);
      const emails = res.body.data.map((u) => u.email);
      expect(emails).toEqual(expect.arrayContaining(['admin@test.com', 'teacher@test.com', 'parent@test.com']));
      expect(emails).not.toContain('other@test.com');
      expect(res.body.data[0]).not.toHaveProperty('emailToken');
      expect(res.body.data[0]).toHaveProperty('isVerifiedSchool');
    });

    it('rejects non-admins', async () => {
      const res = await authenticatedRequest('get', '/api/admin/users', { userId: TEACHER_ID, role: 'TEACHER' });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/admin/users/:id', () => {
    it('returns classes, homeroom and staff profile for a teacher', async () => {
      await pool.query(
        `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
         VALUES ('ALHAADIACADEMY', '3', 'Math', 'Tina Teacher', $1, $2)`,
        [TEACHER_ID, yearId]
      );
      await pool.query(
        `INSERT INTO students (name, school, grade, homeroom_teacher_id, school_year_id)
         VALUES ('Sam Student', 'ALHAADIACADEMY', '3', $1, $2), ('Sue Student', 'ALHAADIACADEMY', '3', $1, $2)`,
        [TEACHER_ID, yearId]
      );
      await pool.query(
        `INSERT INTO staff (school, full_name, staff_role, email, phone)
         VALUES ('ALHAADIACADEMY', 'Tina Teacher', 'Grade 3 Teacher', 'TEACHER@test.com', '555-0100')`
      );

      const res = await authenticatedRequest('get', `/api/admin/users/${TEACHER_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.data.classes).toEqual([
        expect.objectContaining({ grade: '3', subject: 'Math', isLead: true }),
      ]);
      expect(res.body.data.homeroom).toEqual([{ grade: '3', studentCount: 2 }]);
      expect(res.body.data.staffProfile).toEqual(expect.objectContaining({ phone: '555-0100' }));
    });

    it('returns linked children for a parent', async () => {
      const { rows } = await pool.query(
        `INSERT INTO students (name, school, grade, school_year_id)
         VALUES ('Kid One', 'ALHAADIACADEMY', '2', $1) RETURNING student_id`,
        [yearId]
      );
      await pool.query(
        `INSERT INTO parent_students (student_id, parent_id, relation, school) VALUES ($1, $2, 'Father', 'ALHAADIACADEMY')`,
        [rows[0].student_id, PARENT_ID]
      );

      const res = await authenticatedRequest('get', `/api/admin/users/${PARENT_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.data.children).toEqual([
        expect.objectContaining({ name: 'Kid One', relation: 'Father' }),
      ]);
    });

    it('404s for a user in another school', async () => {
      const res = await authenticatedRequest('get', `/api/admin/users/${OTHER_SCHOOL_ID}`);
      expect(res.status).toBe(404);
    });

    it('404s for a malformed id', async () => {
      const res = await authenticatedRequest('get', '/api/admin/users/not-a-uuid');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/admin/users', () => {
    it('creates a pre-approved account with a pending invite token', async () => {
      const res = await authenticatedRequest('post', '/api/admin/users').send({
        firstName: 'New', lastName: 'Hire', email: 'New.Hire@Test.com', role: 'TEACHER',
      });

      expect(res.status).toBe(201);
      expect(res.body.data).toEqual(expect.objectContaining({
        email: 'new.hire@test.com', school: 'ALHAADIACADEMY', invitePending: true, inviteSent: true,
      }));

      const { rows } = await pool.query(
        `SELECT u.is_verified_school, u.password,
                (SELECT expires_at > NOW() + interval '6 days' FROM password_reset_tokens t WHERE t.user_id = u.user_id) AS long_lived
         FROM users u WHERE u.email = 'new.hire@test.com'`
      );
      expect(rows[0]).toEqual({ is_verified_school: true, password: '!', long_lived: true });
    });

    it('409s on a duplicate email', async () => {
      const res = await authenticatedRequest('post', '/api/admin/users').send({
        firstName: 'Dup', lastName: 'User', email: 'teacher@test.com', role: 'TEACHER',
      });
      expect(res.status).toBe(409);
    });

    it('400s on an invalid role', async () => {
      const res = await authenticatedRequest('post', '/api/admin/users').send({
        firstName: 'A', lastName: 'B', email: 'a@b.com', role: 'SUPERUSER',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/admin/users/:id/resend-invite', () => {
    it('replaces the invite token for a pending user', async () => {
      await pool.query(`UPDATE users SET password = '!' WHERE user_id = $1`, [TEACHER_ID]);
      await pool.query(`INSERT INTO password_reset_tokens (user_id, expires_at) VALUES ($1, NOW())`, [TEACHER_ID]);

      const res = await authenticatedRequest('post', `/api/admin/users/${TEACHER_ID}/resend-invite`);

      expect(res.status).toBe(200);
      const { rows } = await pool.query(`SELECT expires_at > NOW() AS valid FROM password_reset_tokens WHERE user_id = $1`, [TEACHER_ID]);
      expect(rows).toEqual([{ valid: true }]);
    });

    it('400s once the user has set a password', async () => {
      const res = await authenticatedRequest('post', `/api/admin/users/${TEACHER_ID}/resend-invite`);
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/admin/users/:id', () => {
    it('updates name, role and access', async () => {
      const res = await authenticatedRequest('patch', `/api/admin/users/${TEACHER_ID}`).send({
        firstName: 'Tina', lastName: 'Admin', role: 'ADMIN', isVerifiedSchool: false,
      });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(expect.objectContaining({
        username: 'Tina Admin', role: 'ADMIN', isVerifiedSchool: false,
      }));
    });

    it('saves and clears a staff title shown to parents', async () => {
      const set = await authenticatedRequest('patch', `/api/admin/users/${TEACHER_ID}`).send({
        firstName: 'Tina', lastName: 'Admin', role: 'ADMIN', isVerifiedSchool: true, staffTitle: '  Vice Principal ',
      });
      expect(set.status).toBe(200);
      expect(set.body.data.staffTitle).toBe('Vice Principal');

      const cleared = await authenticatedRequest('patch', `/api/admin/users/${TEACHER_ID}`).send({
        firstName: 'Tina', lastName: 'Admin', role: 'ADMIN', isVerifiedSchool: true, staffTitle: '',
      });
      expect(cleared.body.data.staffTitle).toBeNull();

      const tooLong = await authenticatedRequest('patch', `/api/admin/users/${TEACHER_ID}`).send({
        firstName: 'Tina', lastName: 'Admin', role: 'ADMIN', isVerifiedSchool: true, staffTitle: 'x'.repeat(61),
      });
      expect(tooLong.status).toBe(400);
    });

    it('stops an admin demoting themselves', async () => {
      const res = await authenticatedRequest('patch', `/api/admin/users/${ADMIN_ID}`).send({
        firstName: 'Admin', lastName: 'User', role: 'TEACHER', isVerifiedSchool: true,
      });
      expect(res.status).toBe(400);
    });

    it('404s for a user in another school', async () => {
      const res = await authenticatedRequest('patch', `/api/admin/users/${OTHER_SCHOOL_ID}`).send({
        firstName: 'Olly', lastName: 'Other', role: 'ADMIN', isVerifiedSchool: true,
      });
      expect(res.status).toBe(404);

      const { rows } = await pool.query(`SELECT role FROM users WHERE user_id = $1`, [OTHER_SCHOOL_ID]);
      expect(rows[0].role).toBe('TEACHER');
    });
  });

  describe('POST /api/admin/users/:id/archive', () => {
    it('archives a user: hidden flag set, school access revoked, invite tokens gone', async () => {
      await pool.query(`INSERT INTO password_reset_tokens (user_id, expires_at) VALUES ($1, NOW() + interval '1 day')`, [TEACHER_ID]);

      const res = await authenticatedRequest('post', `/api/admin/users/${TEACHER_ID}/archive`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(expect.objectContaining({ isArchived: true, isVerifiedSchool: false }));
      expect(res.body.data.archivedAt).toBeTruthy();

      const { rows } = await pool.query(`SELECT is_archived, archived_by FROM users WHERE user_id = $1`, [TEACHER_ID]);
      expect(rows[0]).toEqual({ is_archived: true, archived_by: ADMIN_ID });
      const tokens = await pool.query(`SELECT 1 FROM password_reset_tokens WHERE user_id = $1`, [TEACHER_ID]);
      expect(tokens.rows).toHaveLength(0);

      // Still listed, flagged, and sorted after active users.
      const list = await authenticatedRequest('get', '/api/admin/users');
      const archived = list.body.data.find((u) => u.userId === TEACHER_ID);
      expect(archived.isArchived).toBe(true);
      expect(list.body.data[list.body.data.length - 1].userId).toBe(TEACHER_ID);
    });

    it('409s with the blockers while they lead a class or homeroom this year', async () => {
      await pool.query(
        `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
         VALUES ('ALHAADIACADEMY', '3', 'Math', 'Tina Teacher', $1, $2)`,
        [TEACHER_ID, yearId]
      );
      await pool.query(
        `INSERT INTO students (name, school, grade, homeroom_teacher_id, school_year_id)
         VALUES ('Sam Student', 'ALHAADIACADEMY', '3', $1, $2)`,
        [TEACHER_ID, yearId]
      );

      const res = await authenticatedRequest('post', `/api/admin/users/${TEACHER_ID}/archive`);

      expect(res.status).toBe(409);
      expect(res.body.data.blockers.classes).toEqual([expect.objectContaining({ grade: '3', subject: 'Math' })]);
      expect(res.body.data.blockers.homeroomStudents).toBe(1);

      const details = await authenticatedRequest('get', `/api/admin/users/${TEACHER_ID}`);
      expect(details.body.data.archiveBlockers.classes).toHaveLength(1);
      expect(details.body.data.archiveBlockers.homeroomStudents).toBe(1);

      const { rows } = await pool.query(`SELECT is_archived FROM users WHERE user_id = $1`, [TEACHER_ID]);
      expect(rows[0].is_archived).toBe(false);
    });

    it('ignores classes from other school years', async () => {
      const { rows } = await pool.query(
        `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
         SELECT 'ALHAADIACADEMY', school_id, '2019-2020', DATE '2019-09-01', DATE '2020-06-30', FALSE
         FROM schools WHERE school_code = 'ALHAADIACADEMY' RETURNING school_year_id`
      );
      await pool.query(
        `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
         VALUES ('ALHAADIACADEMY', '3', 'Math', 'Tina Teacher', $1, $2)`,
        [TEACHER_ID, rows[0].school_year_id]
      );

      const res = await authenticatedRequest('post', `/api/admin/users/${TEACHER_ID}/archive`);
      expect(res.status).toBe(200);
    });

    it('judges blockers against the active year even when another year is selected', async () => {
      await pool.query(
        `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
         VALUES ('ALHAADIACADEMY', '3', 'Math', 'Tina Teacher', $1, $2)`,
        [TEACHER_ID, yearId]
      );
      const { rows } = await pool.query(
        `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
         SELECT 'ALHAADIACADEMY', school_id, '2019-2020', DATE '2019-09-01', DATE '2020-06-30', FALSE
         FROM schools WHERE school_code = 'ALHAADIACADEMY' RETURNING school_year_id`
      );

      const res = await authenticatedRequest('post', `/api/admin/users/${TEACHER_ID}/archive`)
        .set('X-School-Year', rows[0].school_year_id);

      expect(res.status).toBe(409);
      expect(res.body.data.blockers.classes).toHaveLength(1);
    });

    it('refuses self-archive, already-archived, and other schools', async () => {
      expect((await authenticatedRequest('post', `/api/admin/users/${ADMIN_ID}/archive`)).status).toBe(400);
      expect((await authenticatedRequest('post', `/api/admin/users/${OTHER_SCHOOL_ID}/archive`)).status).toBe(404);
      await authenticatedRequest('post', `/api/admin/users/${PARENT_ID}/archive`);
      expect((await authenticatedRequest('post', `/api/admin/users/${PARENT_ID}/archive`)).status).toBe(409);
    });

    it('blocks editing an archived account', async () => {
      await authenticatedRequest('post', `/api/admin/users/${PARENT_ID}/archive`);
      const res = await authenticatedRequest('patch', `/api/admin/users/${PARENT_ID}`).send({
        firstName: 'Paul', lastName: 'Parent', role: 'PARENT', isVerifiedSchool: true,
      });
      expect(res.status).toBe(409);
    });
  });

  describe('POST /api/admin/users/:id/unarchive', () => {
    it('restores an archived user with school access', async () => {
      await authenticatedRequest('post', `/api/admin/users/${TEACHER_ID}/archive`);

      const res = await authenticatedRequest('post', `/api/admin/users/${TEACHER_ID}/unarchive`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(expect.objectContaining({ isArchived: false, isVerifiedSchool: true, archivedAt: null }));
      const { rows } = await pool.query(`SELECT archived_by FROM users WHERE user_id = $1`, [TEACHER_ID]);
      expect(rows[0].archived_by).toBeNull();
    });

    it('409s when not archived and 404s for other schools', async () => {
      expect((await authenticatedRequest('post', `/api/admin/users/${TEACHER_ID}/unarchive`)).status).toBe(409);
      expect((await authenticatedRequest('post', `/api/admin/users/${OTHER_SCHOOL_ID}/unarchive`)).status).toBe(404);
    });
  });

  describe('DELETE /api/admin/users/:id', () => {
    it('deletes a user in the school', async () => {
      const res = await authenticatedRequest('delete', `/api/admin/users/${PARENT_ID}`);
      expect(res.status).toBe(200);

      const { rows } = await pool.query(`SELECT 1 FROM users WHERE user_id = $1`, [PARENT_ID]);
      expect(rows).toHaveLength(0);
    });

    it('refuses to delete the admin themselves', async () => {
      const res = await authenticatedRequest('delete', `/api/admin/users/${ADMIN_ID}`);
      expect(res.status).toBe(400);
    });

    it('409s when the user still leads a class', async () => {
      await pool.query(
        `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
         VALUES ('ALHAADIACADEMY', '3', 'Math', 'Tina Teacher', $1, $2)`,
        [TEACHER_ID, yearId]
      );
      const res = await authenticatedRequest('delete', `/api/admin/users/${TEACHER_ID}`);
      expect(res.status).toBe(409);
    });

    it('404s for a user in another school', async () => {
      const res = await authenticatedRequest('delete', `/api/admin/users/${OTHER_SCHOOL_ID}`);
      expect(res.status).toBe(404);
    });
  });
});
