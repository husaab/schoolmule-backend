jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('Integration: Term Routes', () => {
  let app, pool;

  beforeAll(() => {
    app = getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
      [TEST_USER_ID, 'admin@test.com', 'Admin', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN']
    );
  });

  // Helper to create a school and return its ID
  const seedSchool = async () => {
    const { rows } = await pool.query(
      `INSERT INTO schools (school_code, name) VALUES ('ALHAADIACADEMY', 'Al Haadi Academy') RETURNING school_id`
    );
    return rows[0].school_id;
  };

  // Helper to create a term
  const seedTerm = async (schoolId, overrides = {}) => {
    const defaults = {
      school: 'ALHAADIACADEMY',
      name: 'Term 1 2025-2026',
      startDate: '2025-09-01',
      endDate: '2025-12-20',
      academicYear: '2025-2026',
      isActive: false,
    };
    const data = { ...defaults, ...overrides };
    const { rows } = await pool.query(
      `INSERT INTO terms (school, school_id, name, start_date, end_date, academic_year, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [data.school, schoolId, data.name, data.startDate, data.endDate, data.academicYear, data.isActive]
    );
    return rows[0];
  };

  describe('POST /api/terms', () => {
    it('creates a term and persists it in the database', async () => {
      const schoolId = await seedSchool();

      const res = await authenticatedRequest('post', '/api/terms')
        .send({
          school: 'ALHAADIACADEMY',
          schoolId,
          name: 'Term 1 2025-2026',
          startDate: '2025-09-01',
          endDate: '2025-12-20',
          academicYear: '2025-2026',
          isActive: false,
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.name).toBe('Term 1 2025-2026');
      expect(res.body.data.school).toBe('ALHAADIACADEMY');

      const dbResult = await pool.query('SELECT * FROM terms WHERE name = $1', ['Term 1 2025-2026']);
      expect(dbResult.rows).toHaveLength(1);
    });

    it('returns 400 when school is missing', async () => {
      const res = await authenticatedRequest('post', '/api/terms')
        .send({ name: 'Term 1', startDate: '2025-09-01', endDate: '2025-12-20', academicYear: '2025-2026' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when name is missing', async () => {
      const res = await authenticatedRequest('post', '/api/terms')
        .send({ school: 'ALHAADIACADEMY', startDate: '2025-09-01', endDate: '2025-12-20', academicYear: '2025-2026' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when dates are missing', async () => {
      const res = await authenticatedRequest('post', '/api/terms')
        .send({ school: 'ALHAADIACADEMY', name: 'Term 1', academicYear: '2025-2026' });

      expect(res.status).toBe(400);
    });

    it('returns 400 when academic year is missing', async () => {
      const res = await authenticatedRequest('post', '/api/terms')
        .send({ school: 'ALHAADIACADEMY', name: 'Term 1', startDate: '2025-09-01', endDate: '2025-12-20' });

      expect(res.status).toBe(400);
    });

    it('deactivates other terms when creating an active term', async () => {
      const schoolId = await seedSchool();
      const existingTerm = await seedTerm(schoolId, { isActive: true });

      await authenticatedRequest('post', '/api/terms')
        .send({
          school: 'ALHAADIACADEMY',
          schoolId,
          name: 'Term 2 2025-2026',
          startDate: '2026-01-05',
          endDate: '2026-03-20',
          academicYear: '2025-2026',
          isActive: true,
        });

      const dbResult = await pool.query('SELECT is_active FROM terms WHERE term_id = $1', [existingTerm.term_id]);
      expect(dbResult.rows[0].is_active).toBe(false);
    });
  });

  describe('GET /api/terms?school=', () => {
    it('returns all terms for a school', async () => {
      const schoolId = await seedSchool();
      await seedTerm(schoolId, { name: 'Term 1' });
      await seedTerm(schoolId, { name: 'Term 2', startDate: '2026-01-05', endDate: '2026-03-20' });

      const res = await authenticatedRequest('get', '/api/terms?school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);
    });

    it('returns 400 when school param is missing', async () => {
      const res = await authenticatedRequest('get', '/api/terms');

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/terms/:id', () => {
    it('returns a term by ID', async () => {
      const schoolId = await seedSchool();
      const term = await seedTerm(schoolId);

      const res = await authenticatedRequest('get', `/api/terms/${term.term_id}`);

      expect(res.status).toBe(200);
      expect(res.body.data.termId).toBe(term.term_id);
      expect(res.body.data.name).toBe('Term 1 2025-2026');
    });

    it('returns 404 for non-existent term', async () => {
      const res = await authenticatedRequest('get', '/api/terms/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/terms/active?school=', () => {
    it('returns the active term', async () => {
      const schoolId = await seedSchool();
      await seedTerm(schoolId, { name: 'Inactive Term', isActive: false });
      await seedTerm(schoolId, { name: 'Active Term', isActive: true, startDate: '2026-01-05', endDate: '2026-03-20' });

      const res = await authenticatedRequest('get', '/api/terms/active?school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Active Term');
      expect(res.body.data.isActive).toBe(true);
    });

    it('returns 404 when no active term exists', async () => {
      const schoolId = await seedSchool();
      await seedTerm(schoolId, { isActive: false });

      const res = await authenticatedRequest('get', '/api/terms/active?school=ALHAADIACADEMY');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/terms/by-name?termName=&school=', () => {
    it('returns a term by name and school', async () => {
      const schoolId = await seedSchool();
      await seedTerm(schoolId, { name: 'Term 1 2025-2026' });

      const res = await authenticatedRequest('get', '/api/terms/by-name?termName=Term 1 2025-2026&school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Term 1 2025-2026');
    });

    it('returns 400 when parameters are missing', async () => {
      const res = await authenticatedRequest('get', '/api/terms/by-name?termName=Term 1');

      expect(res.status).toBe(400);
    });

    it('returns 404 when term is not found', async () => {
      const res = await authenticatedRequest('get', '/api/terms/by-name?termName=NonExistent&school=ALHAADIACADEMY');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/terms/academic-year?school=&year=', () => {
    it('returns terms for a specific academic year', async () => {
      const schoolId = await seedSchool();
      await seedTerm(schoolId, { name: 'Term 1', academicYear: '2025-2026' });
      await seedTerm(schoolId, { name: 'Term 2', startDate: '2026-01-05', endDate: '2026-03-20', academicYear: '2025-2026' });

      const res = await authenticatedRequest('get', '/api/terms/academic-year?school=ALHAADIACADEMY&year=2025-2026');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('returns 400 when school is missing', async () => {
      const res = await authenticatedRequest('get', '/api/terms/academic-year?year=2025-2026');

      expect(res.status).toBe(400);
    });

    it('returns 400 when year is missing', async () => {
      const res = await authenticatedRequest('get', '/api/terms/academic-year?school=ALHAADIACADEMY');

      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/terms/:id', () => {
    it('updates a term', async () => {
      const schoolId = await seedSchool();
      const term = await seedTerm(schoolId);

      const res = await authenticatedRequest('put', `/api/terms/${term.term_id}`)
        .send({
          name: 'Term 1 Updated',
          startDate: '2025-09-05',
          endDate: '2025-12-22',
          academicYear: '2025-2026',
          isActive: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Term 1 Updated');
    });

    it('returns 400 when name is missing', async () => {
      const schoolId = await seedSchool();
      const term = await seedTerm(schoolId);

      const res = await authenticatedRequest('put', `/api/terms/${term.term_id}`)
        .send({ startDate: '2025-09-05', endDate: '2025-12-22', academicYear: '2025-2026' });

      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent term', async () => {
      const res = await authenticatedRequest('put', '/api/terms/00000000-0000-0000-0000-000000000000')
        .send({ name: 'Test', startDate: '2025-09-01', endDate: '2025-12-20', academicYear: '2025-2026' });

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/terms/:id/activate', () => {
    it('activates a term and deactivates others', async () => {
      const schoolId = await seedSchool();
      const term1 = await seedTerm(schoolId, { name: 'Term 1', isActive: true });
      const term2 = await seedTerm(schoolId, { name: 'Term 2', isActive: false, startDate: '2026-01-05', endDate: '2026-03-20' });

      const res = await authenticatedRequest('put', `/api/terms/${term2.term_id}/activate`);

      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(true);

      const dbResult = await pool.query('SELECT is_active FROM terms WHERE term_id = $1', [term1.term_id]);
      expect(dbResult.rows[0].is_active).toBe(false);
    });

    it('returns 404 for non-existent term', async () => {
      const res = await authenticatedRequest('put', '/api/terms/00000000-0000-0000-0000-000000000000/activate');

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/terms/:id/status', () => {
    it('activates a term via status endpoint', async () => {
      const schoolId = await seedSchool();
      const term = await seedTerm(schoolId, { isActive: false });

      const res = await authenticatedRequest('put', `/api/terms/${term.term_id}/status`)
        .send({ isActive: true });

      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(true);
    });

    it('deactivates a term via status endpoint', async () => {
      const schoolId = await seedSchool();
      const term = await seedTerm(schoolId, { isActive: true });

      const res = await authenticatedRequest('put', `/api/terms/${term.term_id}/status`)
        .send({ isActive: false });

      expect(res.status).toBe(200);
      expect(res.body.data.isActive).toBe(false);
    });

    it('returns 400 when isActive is not boolean', async () => {
      const schoolId = await seedSchool();
      const term = await seedTerm(schoolId);

      const res = await authenticatedRequest('put', `/api/terms/${term.term_id}/status`)
        .send({ isActive: 'yes' });

      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent term', async () => {
      const res = await authenticatedRequest('put', '/api/terms/00000000-0000-0000-0000-000000000000/status')
        .send({ isActive: true });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/terms/:id', () => {
    it('deletes a term', async () => {
      const schoolId = await seedSchool();
      const term = await seedTerm(schoolId);

      const res = await authenticatedRequest('delete', `/api/terms/${term.term_id}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const dbResult = await pool.query('SELECT * FROM terms WHERE term_id = $1', [term.term_id]);
      expect(dbResult.rows).toHaveLength(0);
    });

    it('returns 404 for non-existent term', async () => {
      const res = await authenticatedRequest('delete', '/api/terms/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/terms?school=ALHAADIACADEMY');

      expect(res.status).toBe(401);
    });
  });
});
