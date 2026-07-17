jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

describe('schedule planner rooms are year-scoped', () => {
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

    // planner_rooms has UNIQUE(school, name), so use distinct names per year.
    await pool.query(
      `INSERT INTO planner_rooms (school, school_id, name, school_year_id) VALUES
       ('ALHAADIACADEMY', $1, 'Room A (2025)', $2),
       ('ALHAADIACADEMY', $1, 'Room B (2026)', $3)`,
      [schoolId, year25, year26]
    );
  });

  it('GET /api/schedule-planner/rooms returns only the selected year\'s room', async () => {
    const res25 = await authenticatedRequest('get', '/api/schedule-planner/rooms')
      .set('X-School-Year', year25);
    expect(res25.status).toBe(200);
    expect(res25.body.data.map(r => r.name)).toEqual(['Room A (2025)']);

    const res26 = await authenticatedRequest('get', '/api/schedule-planner/rooms')
      .set('X-School-Year', year26);
    expect(res26.status).toBe(200);
    expect(res26.body.data.map(r => r.name)).toEqual(['Room B (2026)']);
  });

  it('POST /api/schedule-planner/rooms stamps the selected year', async () => {
    const res = await authenticatedRequest('post', '/api/schedule-planner/rooms')
      .set('X-School-Year', year26)
      .send({ name: 'Gym', capacityNote: 'Whole school' });

    expect(res.status).toBe(201);
    const { rows } = await pool.query(`SELECT school_year_id FROM planner_rooms WHERE name = 'Gym'`);
    expect(rows[0].school_year_id).toBe(year26);
  });
});
