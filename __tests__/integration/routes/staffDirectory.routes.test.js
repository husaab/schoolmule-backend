// The staff directory (GET /api/staff) pictures each person with their account's
// avatar and uploaded photo, matched by email within the school.
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_SCHOOL_ID = '550e8400-e29b-41d4-a716-446655440009';

describe('Integration: Staff directory', () => {
  let pool;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, school, extra = {}) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, avatar, photo_path)
     VALUES ($1, $2, $6, 'hashed', 'Rana', 'Saleh', $3, 'TEACHER', true, true, $4::jsonb, $5)`,
    [id, email, school, extra.avatar ? JSON.stringify(extra.avatar) : null, extra.photoPath ?? null, `rana-${id.slice(-4)}`],
  );
  const staff = (name, email) => pool.query(
    `INSERT INTO staff (school, full_name, staff_role, email) VALUES ('ALHAADIACADEMY', $1, 'Teacher', $2)`, [name, email],
  );
  const directory = async () => (await authenticatedRequest('get', '/api/staff')).body.data;

  it("shows the matching account's avatar and photo; a row with no account gets neither", async () => {
    const avatar = { style: 'hijab', skin: 2, bg: 4 };
    await user(TEACHER_ID, 'rana.saleh@example.com', 'ALHAADIACADEMY', { avatar, photoPath: 'ALHAADIACADEMY/rana/p.png' });
    await staff('Rana Saleh', 'Rana.Saleh@Example.com');
    await staff('Omar Haddad', 'omar.haddad@example.com');

    const rows = await directory();
    expect(rows.find((r) => r.fullName === 'Rana Saleh')).toMatchObject({
      avatar, photoUrl: 'https://mock-signed-url.com/ALHAADIACADEMY/rana/p.png',
    });
    expect(rows.find((r) => r.fullName === 'Omar Haddad')).toMatchObject({ avatar: null, photoUrl: null });
    expect(JSON.stringify(rows)).not.toContain('photoPath');
  });

  it("never borrows a picture from another school's account with the same email", async () => {
    await user(OTHER_SCHOOL_ID, 'rana.saleh@example.com', 'PLAYGROUND', { photoPath: 'PLAYGROUND/rana/p.png' });
    await staff('Rana Saleh', 'rana.saleh@example.com');
    expect((await directory()).find((r) => r.fullName === 'Rana Saleh')).toMatchObject({ avatar: null, photoUrl: null });
  });
});
