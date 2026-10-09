const bcrypt = require('bcrypt');
const db = require('../../__mocks__/config/database');
jest.mock('../../../services/observe/eventBuffer', () => ({ push: jest.fn(() => true), stats: () => ({ pending: 0, dropped: 0, flushes: 0, failures: 0 }), start: jest.fn(), stop: jest.fn(), flushNow: jest.fn(() => Promise.resolve()) }));
const buffer = require('../../../services/observe/eventBuffer');
const { getApp } = require('../../helpers/testApp');
const request = require('supertest');

const USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const userRow = (over = {}) => ({
  user_id: USER_ID, email: 'owner@test.com', username: 'Own Er', password: 'hash', first_name: 'Own', last_name: 'Er',
  school: 'ALHAADIACADEMY', role: 'ADMIN', is_verified: true, is_verified_school: true, is_archived: false, ...over,
});

beforeEach(() => {
  buffer.push.mockClear();
  process.env.PLATFORM_OWNER_EMAILS = 'owner@test.com';
});
afterEach(() => { delete process.env.PLATFORM_OWNER_EMAILS; jest.restoreAllMocks(); });

const post = (body) => request(getApp()).post('/api/auth/login').set('User-Agent', 'jest-ua').send(body);

describe('login observe hooks', () => {
  it('records success, touches last_login_at and returns isPlatformOwner', async () => {
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
    db.query.mockResolvedValueOnce({ rows: [userRow()] });      // loginUser
    db.query.mockResolvedValueOnce({ rows: [] });                // touchLastLogin
    const res = await post({ email: 'Owner@Test.com', password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body.data.isPlatformOwner).toBe(true);
    expect(buffer.push).toHaveBeenCalledWith('login_events', expect.objectContaining({
      email: 'owner@test.com', user_id: USER_ID, school: 'ALHAADIACADEMY', outcome: 'success', user_agent: 'jest-ua',
    }));
    expect(db.query.mock.calls.some(([sql]) => sql.includes('last_login_at'))).toBe(true);
  });

  it('returns 401 (not 500) for a wrong password and records bad_password', async () => {
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(false);
    db.query.mockResolvedValueOnce({ rows: [userRow({ email: 'teacher@test.com' })] });
    const res = await post({ email: 'teacher@test.com', password: 'nope' });
    expect(res.status).toBe(401);
    expect(buffer.push).toHaveBeenCalledWith('login_events', expect.objectContaining({ outcome: 'bad_password', user_id: USER_ID }));
  });

  it('returns 404 and records unknown_email with no user_id', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await post({ email: 'ghost@test.com', password: 'x' });
    expect(res.status).toBe(404);
    expect(buffer.push).toHaveBeenCalledWith('login_events', expect.objectContaining({ outcome: 'unknown_email', user_id: null, email: 'ghost@test.com' }));
  });

  it('returns 403 and records archived', async () => {
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
    db.query.mockResolvedValueOnce({ rows: [userRow({ is_archived: true, email: 't@test.com' })] });
    const res = await post({ email: 't@test.com', password: 'pw' });
    expect(res.status).toBe(403);
    expect(buffer.push).toHaveBeenCalledWith('login_events', expect.objectContaining({ outcome: 'archived' }));
  });

  it('isPlatformOwner is false for everyone else', async () => {
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
    db.query.mockResolvedValueOnce({ rows: [userRow({ email: 'admin@school.com' })] });
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await post({ email: 'admin@school.com', password: 'pw' });
    expect(res.body.data.isPlatformOwner).toBe(false);
  });
});
