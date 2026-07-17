const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

describe('students are year-scoped', () => {
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

    await pool.query(`DELETE FROM students WHERE school = 'ALHAADIACADEMY'`);
    await pool.query(`DELETE FROM school_years WHERE school = 'ALHAADIACADEMY'`);
    const y = await pool.query(
      `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active) VALUES
       ('ALHAADIACADEMY', $1, '2025-2026', '2025-09-01', '2026-06-30', TRUE),
       ('ALHAADIACADEMY', $1, '2026-2027', '2026-09-01', '2027-06-30', FALSE)
       RETURNING school_year_id, label`, [schoolId]);
    year25 = y.rows.find(r => r.label === '2025-2026').school_year_id;
    year26 = y.rows.find(r => r.label === '2026-2027').school_year_id;
    await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES
       ('Old Kid', '3', 'ALHAADIACADEMY', $1),
       ('New Kid', '4', 'ALHAADIACADEMY', $2)`, [year25, year26]);
  });

  it('GET /api/students returns only the selected year', async () => {
    const res25 = await authenticatedRequest('get', '/api/students').set('X-School-Year', year25);
    expect(res25.body.data.map(s => s.name)).toEqual(['Old Kid']);

    const res26 = await authenticatedRequest('get', '/api/students').set('X-School-Year', year26);
    expect(res26.body.data.map(s => s.name)).toEqual(['New Kid']);
  });

  it('GET /api/students defaults to the active year without a header', async () => {
    const res = await authenticatedRequest('get', '/api/students');
    expect(res.body.data.map(s => s.name)).toEqual(['Old Kid']);
  });

  it('POST /api/students stamps the selected year', async () => {
    const res = await authenticatedRequest('post', '/api/students')
      .set('X-School-Year', year26)
      .send({ name: 'Created Kid', grade: '5' });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(`SELECT school_year_id FROM students WHERE name = 'Created Kid'`);
    expect(rows[0].school_year_id).toBe(year26);
  });

  it('teacher cannot create a student in a non-active year', async () => {
    const res = await authenticatedRequest('post', '/api/students', { role: 'TEACHER' })
      .set('X-School-Year', year26)
      .send({ name: 'Blocked Kid', grade: '5' });
    expect(res.status).toBe(403);
  });
});
