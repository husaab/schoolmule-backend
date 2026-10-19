// The app's global limiter (1000 requests a minute) against the real app
// (final review I3): a school's students and teachers share one public IP, so
// a signed-in user's requests count against that user, not the network.

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');

const NETWORK = '192.0.2.44';
const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440001', role: 'TEACHER', email: 'ziad.teacher@example.com' };
const STUDENT = { userId: '550e8400-e29b-41d4-a716-446655440010', role: 'STUDENT', roles: ['STUDENT'], email: 'amal.haddad@example.com' };

describe('Integration: global rate limit', () => {
  beforeAll(() => { getApp(); });

  it('one busy user on the school network is limited; the rest of the school is not', async () => {
    const asTeacher = () => authenticatedRequest('get', '/api/health', TEACHER).set('X-Forwarded-For', NETWORK);
    for (let sent = 0; sent < 1000; sent += 50) {
      const batch = await Promise.all(Array.from({ length: 50 }, () => asTeacher()));
      expect(batch.every((r) => r.status === 200)).toBe(true);
    }
    expect((await asTeacher()).status).toBe(429);
    // A student and an anonymous visitor on the same network still get through.
    expect((await authenticatedRequest('get', '/api/health', STUDENT).set('X-Forwarded-For', NETWORK)).status).toBe(200);
    expect((await request(getApp()).get('/api/health').set('X-Forwarded-For', NETWORK)).status).toBe(200);
  }, 60000);
});
