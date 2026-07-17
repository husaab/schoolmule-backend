jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

describe('school calendar events are year-scoped', () => {
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
      `INSERT INTO school_calendar_events (school, school_id, title, category, start_date, school_year_id) VALUES
       ('ALHAADIACADEMY', $1, 'Old Year PA Day', 'pa-day', '2025-10-15', $2),
       ('ALHAADIACADEMY', $1, 'New Year PA Day', 'pa-day', '2026-10-15', $3)`,
      [schoolId, year25, year26]
    );
  });

  it('GET /api/calendar-events returns only the selected year\'s event', async () => {
    const res25 = await authenticatedRequest('get', '/api/calendar-events?school=ALHAADIACADEMY')
      .set('X-School-Year', year25);
    expect(res25.status).toBe(200);
    expect(res25.body.data.map(e => e.title)).toEqual(['Old Year PA Day']);

    const res26 = await authenticatedRequest('get', '/api/calendar-events?school=ALHAADIACADEMY')
      .set('X-School-Year', year26);
    expect(res26.status).toBe(200);
    expect(res26.body.data.map(e => e.title)).toEqual(['New Year PA Day']);
  });

  it('POST /api/calendar-events stamps the selected year', async () => {
    const res = await authenticatedRequest('post', '/api/calendar-events')
      .set('X-School-Year', year26)
      .send({ school: 'ALHAADIACADEMY', title: 'New Event', startDate: '2026-11-01' });

    expect(res.status).toBe(201);
    const { rows } = await pool.query(`SELECT school_year_id FROM school_calendar_events WHERE title = 'New Event'`);
    expect(rows[0].school_year_id).toBe(year26);
  });
});
