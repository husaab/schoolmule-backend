jest.mock('../../../services/observe/eventBuffer', () => ({ push: jest.fn(() => true), stats: () => ({ pending: 0 }), start: jest.fn(), stop: jest.fn(), flushNow: jest.fn(() => Promise.resolve()) }));
const buffer = require('../../../services/observe/eventBuffer');
const { authenticatedRequest } = require('../../helpers/testApp');
const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockParentUser, mockUnverifiedUser, mockUnverifiedSchoolUser, TEST_PARENT_USER_ID, TEST_ADMIN_USER_ID } = require('../../helpers/mockAuth');

beforeEach(() => buffer.push.mockClear());

describe('POST /api/observe/client-events', () => {
  it('accepts a batch from any signed-in user (no owner gate) and stamps identity', async () => {
    const res = await authenticatedRequest('post', '/api/observe/client-events', mockParentUser())
      .set('User-Agent', 'jest-ua')
      .send({ events: [{ kind: 'js_error', message: 'Cannot read x', stack: 'TypeError: x\n at y', page: '/parent/dashboard' }, { kind: 'api_failure', message: 'Error fetching', status: 500, requestId: 'r1' }] });
    expect(res.status).toBe(204);
    expect(buffer.push).toHaveBeenCalledTimes(2);
    expect(buffer.push.mock.calls[0][1]).toEqual(expect.objectContaining({ user_id: TEST_PARENT_USER_ID, role: 'PARENT', kind: 'js_error', page: '/parent/dashboard', user_agent: 'jest-ua' }));
    expect(buffer.push.mock.calls[0][1].fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(buffer.push.mock.calls[1][1]).toEqual(expect.objectContaining({ kind: 'api_failure', status: 500, request_id: 'r1' }));
  });
  it('drops a status that is not an HTTP status (client_events.status is a SMALLINT)', async () => {
    const res = await authenticatedRequest('post', '/api/observe/client-events', mockParentUser())
      .send({ events: [{ kind: 'api_failure', message: 'x', status: 99999999 }, { kind: 'api_failure', message: 'y', status: 404 }] });
    expect(res.status).toBe(204);
    expect(buffer.push.mock.calls[0][1].status).toBeNull();
    expect(buffer.push.mock.calls[1][1].status).toBe(404);
  });

  it('rejects bad kinds, missing messages and oversized batches', async () => {
    expect((await authenticatedRequest('post', '/api/observe/client-events', mockParentUser()).send({ events: [{ kind: 'nope', message: 'x' }] })).status).toBe(400);
    expect((await authenticatedRequest('post', '/api/observe/client-events', mockParentUser()).send({ events: [{ kind: 'js_error' }] })).status).toBe(400);
    expect((await authenticatedRequest('post', '/api/observe/client-events', mockParentUser()).send({ events: Array(21).fill({ kind: 'js_error', message: 'x' }) })).status).toBe(413);
    expect(buffer.push).not.toHaveBeenCalled();
  });
  it.each([
    ['email-unverified', () => mockUnverifiedUser({ userId: TEST_ADMIN_USER_ID, role: 'PARENT' })],
    ['school-pending', () => mockUnverifiedSchoolUser({ userId: TEST_ADMIN_USER_ID, role: 'PARENT' })],
  ])('accepts a redirect_loop report from an %s account', async (_label, token) => {
    const res = await authenticatedRequest('post', '/api/observe/client-events', token())
      .send({ events: [{ kind: 'redirect_loop', message: '/verify-email -> /login -> /verify-email', page: '/verify-email' }] });
    expect(res.status).toBe(204);
    expect(buffer.push).toHaveBeenCalledWith('client_events', expect.objectContaining({ kind: 'redirect_loop', user_id: TEST_ADMIN_USER_ID, role: 'PARENT' }));
  });
  it('still rejects an unknown kind from an unverified account', async () => {
    const res = await authenticatedRequest('post', '/api/observe/client-events', mockUnverifiedUser()).send({ events: [{ kind: 'nope', message: 'x' }] });
    expect(res.status).toBe(400);
    expect(buffer.push).not.toHaveBeenCalled();
  });
  it('still requires a valid token', async () => {
    const events = { events: [{ kind: 'js_error', message: 'x' }] };
    expect((await request(getApp()).post('/api/observe/client-events').send(events)).status).toBe(401);
    expect((await request(getApp()).post('/api/observe/client-events').set('Authorization', 'Bearer junk').send(events)).status).toBe(401);
    expect(buffer.push).not.toHaveBeenCalled();
  });
  it('leaves the rest of /api/observe behind the full guard', async () => {
    const res = await authenticatedRequest('get', '/api/observe/overview', mockUnverifiedUser());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_NOT_VERIFIED');
  });
  it('truncates long fields', async () => {
    await authenticatedRequest('post', '/api/observe/client-events', mockParentUser()).send({ events: [{ kind: 'js_error', message: 'm'.repeat(900), stack: 's'.repeat(5000), page: 'p'.repeat(500) }] });
    const row = buffer.push.mock.calls[0][1];
    expect(row.message).toHaveLength(500);
    expect(row.stack).toHaveLength(2000);
    expect(row.page).toHaveLength(300);
  });
});
