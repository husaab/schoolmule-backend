// The legacy /api/users routes may never do more than the Users page allows.
const { authenticatedRequest } = require('../../helpers/testApp');
const { mockAdminUser, TEST_ADMIN_USER_ID, TEST_TEACHER_USER_ID, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const { buildUserRow } = require('../../helpers/factories');
const { giveRole } = require('../../helpers/mockAccess');
const db = require('../../__mocks__/config/database');

const teacher = buildUserRow({ user_id: TEST_TEACHER_USER_ID, role: 'TEACHER', school: TEST_SCHOOL, staff_role_id: null });
const fullAdmin = buildUserRow({ user_id: TEST_TEACHER_USER_ID, role: 'ADMIN', school: TEST_SCHOOL, staff_role_id: null });
const body = (role) => ({ email: 'user@test.com', username: 'Test User', school: TEST_SCHOOL, role });
const updates = () => db.query.mock.calls.filter(([sql]) => /UPDATE users/i.test(sql));

describe('legacy /api/users escalation', () => {
  it('refuses a users holder (not a full admin) making a teacher an admin', async () => {
    giveRole(TEST_ADMIN_USER_ID, ['users']);
    mockQueryResponse([teacher]);
    const res = await authenticatedRequest('put', `/api/users/${TEST_TEACHER_USER_ID}`, mockAdminUser()).send(body('ADMIN'));
    expect(res.status).toBe(403);
    expect(updates()).toHaveLength(0);
  });

  it('refuses a role that is not a staff or parent role, even from a full admin', async () => {
    mockQueryResponse([teacher]);
    const res = await authenticatedRequest('put', `/api/users/${TEST_TEACHER_USER_ID}`).send(body('STUDENT'));
    expect(res.status).toBe(403);
  });

  it('refuses a users holder editing or deleting a full admin', async () => {
    giveRole(TEST_ADMIN_USER_ID, ['users']);
    mockQueryResponse([fullAdmin]);
    const put = await authenticatedRequest('put', `/api/users/${TEST_TEACHER_USER_ID}`).send(body('ADMIN'));
    expect(put.status).toBe(403);

    mockQueryResponse([fullAdmin]);
    const del = await authenticatedRequest('delete', `/api/users/${TEST_TEACHER_USER_ID}`);
    expect(del.status).toBe(403);
  });

  it('refuses an admin without the users permission', async () => {
    giveRole(TEST_ADMIN_USER_ID, ['forms']);
    const res = await authenticatedRequest('get', '/api/users');
    expect(res.status).toBe(403);
  });

  it('still lets a full admin change a role', async () => {
    mockQueryResponse([teacher]);
    mockQueryResponse([], 1);
    const res = await authenticatedRequest('put', `/api/users/${TEST_TEACHER_USER_ID}`).send(body('ADMIN'));
    expect(res.status).toBe(200);
  });
});
