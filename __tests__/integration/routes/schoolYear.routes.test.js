const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

describe('/api/school-years', () => {
  let app, pool, schoolId;

  beforeAll(async () => {
    app = getApp();
    pool = getTestPool();
    const { rows } = await pool.query(
      `SELECT school_id FROM schools WHERE school_code = 'ALHAADIACADEMY'`);
    schoolId = rows[0]?.school_id;
  });

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ('550e8400-e29b-41d4-a716-446655440000', 'admin@test.com', 'Admin', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN', true, true)`
    );
    // setupTestDB's global beforeEach already seeds a baseline ALHAADIACADEMY
    // row (+ active school_year via trigger); upsert instead of a plain
    // INSERT so this doesn't collide with it.
    const { rows } = await pool.query(
      `INSERT INTO schools (school_code, name) VALUES ('ALHAADIACADEMY', 'Al Haadi Academy')
       ON CONFLICT (school_code) DO UPDATE SET name = EXCLUDED.name
       RETURNING school_id`
    );
    schoolId = rows[0].school_id;

    await pool.query(`DELETE FROM school_years WHERE school = 'ALHAADIACADEMY'`);
    await pool.query(
      `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
       VALUES ('ALHAADIACADEMY', $1, '2025-2026', '2025-09-01', '2026-06-30', TRUE)`, [schoolId]);
  });

  it('lists years for the caller school only', async () => {
    const res = await authenticatedRequest('get', '/api/school-years');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ label: '2025-2026', isActive: true });
    expect(res.body.data[0].schoolYearId).toBeDefined();
  });

  it('creates a draft year with created_from set to the active year', async () => {
    const res = await authenticatedRequest('post', '/api/school-years')
      .send({ label: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30' });
    expect(res.status).toBe(201);
    expect(res.body.data.isActive).toBe(false);
    expect(res.body.data.createdFromYearId).toBeDefined();
  });

  it('rejects a bad label', async () => {
    const res = await authenticatedRequest('post', '/api/school-years')
      .send({ label: 'next year', startDate: '2026-09-01', endDate: '2027-06-30' });
    expect(res.status).toBe(400);
  });

  it('rejects duplicate labels with 409', async () => {
    const res = await authenticatedRequest('post', '/api/school-years')
      .send({ label: '2025-2026', startDate: '2025-09-01', endDate: '2026-06-30' });
    expect(res.status).toBe(409);
  });

  it('refuses to activate a year with no terms, then activates once terms exist', async () => {
    const create = await authenticatedRequest('post', '/api/school-years')
      .send({ label: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30' });
    const id = create.body.data.schoolYearId;

    const bad = await authenticatedRequest('put', `/api/school-years/${id}/activate`);
    expect(bad.status).toBe(409);

    await pool.query(
      `INSERT INTO terms (school, school_id, name, start_date, end_date, academic_year, is_active, school_year_id)
       VALUES ('ALHAADIACADEMY', $1, 'Term 1', '2026-09-01', '2027-01-31', '2026-2027', FALSE, $2)`,
      [schoolId, id]);

    const ok = await authenticatedRequest('put', `/api/school-years/${id}/activate`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.isActive).toBe(true);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active`);
    expect(rows[0].n).toBe(1); // old year deactivated
  });

  it('refuses to delete the active year', async () => {
    const list = await authenticatedRequest('get', '/api/school-years');
    const activeId = list.body.data[0].schoolYearId;
    const res = await authenticatedRequest('delete', `/api/school-years/${activeId}`);
    expect(res.status).toBe(409);
  });

  it('blocks non-admin mutations', async () => {
    const res = await authenticatedRequest('post', '/api/school-years', { role: 'TEACHER' })
      .send({ label: '2026-2027', startDate: '2026-09-01', endDate: '2027-06-30' });
    expect(res.status).toBe(403);
  });
});
