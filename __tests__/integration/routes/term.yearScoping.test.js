jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

describe('terms are year-scoped', () => {
  let pool, schoolId, year25, year26;

  beforeAll(async () => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    // setupTestDB's global beforeEach already seeds a baseline ALHAADIACADEMY
    // row (+ active school_year via trigger); look it up rather than
    // inserting a fresh school row.
    const { rows } = await pool.query(
      `SELECT school_id FROM schools WHERE school_code = 'ALHAADIACADEMY'`);
    schoolId = rows[0].school_id;

    await pool.query(`DELETE FROM school_years WHERE school = 'ALHAADIACADEMY'`);
    const y = await pool.query(
      `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active) VALUES
       ('ALHAADIACADEMY', $1, '2025-2026', '2025-09-01', '2026-06-30', TRUE),
       ('ALHAADIACADEMY', $1, '2026-2027', '2026-09-01', '2027-06-30', FALSE)
       RETURNING school_year_id, label`, [schoolId]);
    year25 = y.rows.find(r => r.label === '2025-2026').school_year_id;
    year26 = y.rows.find(r => r.label === '2026-2027').school_year_id;

    await pool.query(
      `INSERT INTO terms (school, school_id, name, start_date, end_date, academic_year, is_active, school_year_id) VALUES
       ('ALHAADIACADEMY', $1, 'Term 1 2025-2026', '2025-09-01', '2025-12-20', '2025-2026', true, $2),
       ('ALHAADIACADEMY', $1, 'Term 1 2026-2027', '2026-09-01', '2026-12-20', '2026-2027', true, $3)`,
      [schoolId, year25, year26]
    );
  });

  it('GET /api/terms returns only the selected year\'s terms', async () => {
    const res25 = await authenticatedRequest('get', '/api/terms?school=ALHAADIACADEMY').set('X-School-Year', year25);
    expect(res25.body.data.map(t => t.academicYear)).toEqual(['2025-2026']);

    const res26 = await authenticatedRequest('get', '/api/terms?school=ALHAADIACADEMY').set('X-School-Year', year26);
    expect(res26.body.data.map(t => t.academicYear)).toEqual(['2026-2027']);
  });

  it('GET /api/terms defaults to the active year without a header', async () => {
    const res = await authenticatedRequest('get', '/api/terms?school=ALHAADIACADEMY');
    expect(res.body.data.map(t => t.academicYear)).toEqual(['2025-2026']);
  });

  it('POST /api/terms stamps the term with the selected year', async () => {
    const res = await authenticatedRequest('post', '/api/terms')
      .set('X-School-Year', year26)
      .send({
        name: 'Term 2 2026-2027',
        startDate: '2027-01-05',
        endDate: '2027-06-25',
        academicYear: '2026-2027',
      });

    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT school_year_id FROM terms WHERE name = 'Term 2 2026-2027'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].school_year_id).toBe(year26);
  });
});
