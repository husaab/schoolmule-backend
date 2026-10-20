// RBAC on the Users page: someone who manages users but is not a full admin
// can't widen anyone's access (services/access/escalation.js).
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { authenticatedRequest } = require('../../helpers/testApp');
const { mockAdminUser, TEST_ADMIN_USER_ID, TEST_TEACHER_USER_ID } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const { buildUserRow } = require('../../helpers/factories');
const { giveRole } = require('../../helpers/mockAccess');
const store = require('../../../services/access/accessStore');
const db = require('../../__mocks__/config/database');

const ROLE_ID = '9b0c1e9a-1d2f-4c6b-8a77-2b9d0e5f4a10';
const userCalls = () => db.query.mock.calls.filter(([sql]) => !/FROM school_years/.test(sql));

const target = (fields = {}) => buildUserRow({
  user_id: TEST_TEACHER_USER_ID, role: 'TEACHER', first_name: 'Tess', last_name: 'Teacher',
  is_archived: false, staff_role_id: null, ...fields,
});
const edit = (fields = {}) => ({ firstName: 'Tess', lastName: 'Teacher', role: 'TEACHER', isVerifiedSchool: true, ...fields });

const asOffice = () => giveRole(TEST_ADMIN_USER_ID, ['users'], 'Office Staff');

describe('Users page escalation guards', () => {
  it('needs the users permission at all', async () => {
    giveRole(TEST_ADMIN_USER_ID, ['forms']);
    const res = await authenticatedRequest('get', '/api/admin/users', mockAdminUser());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  describe('invite', () => {
    it('refuses an administrator invite from a users holder', async () => {
      asOffice();
      const res = await authenticatedRequest('post', '/api/admin/users')
        .send({ firstName: 'A', lastName: 'B', email: 'new@test.com', role: 'ADMIN' });
      expect(res.status).toBe(403);
      expect(userCalls()).toHaveLength(0);
    });

    it('refuses giving an access role on invite unless full admin', async () => {
      asOffice();
      const res = await authenticatedRequest('post', '/api/admin/users')
        .send({ firstName: 'A', lastName: 'B', email: 'new@test.com', role: 'TEACHER', accessRoleId: ROLE_ID });
      expect(res.status).toBe(403);
    });

    it('lets a full admin invite with an access role', async () => {
      mockQueryResponse([{ role_id: ROLE_ID, name: 'Office Staff' }]); // role in school
      mockQueryResponse([target({ user_id: 'new-user', staff_role_id: ROLE_ID, staff_role_name: 'Office Staff', invite_pending: true })]);
      mockQueryResponse([{ token: 'tok' }]);
      mockQueryResponse([{ name: 'Test School' }]);
      const res = await authenticatedRequest('post', '/api/admin/users')
        .send({ firstName: 'A', lastName: 'B', email: 'new@test.com', role: 'TEACHER', accessRoleId: ROLE_ID });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ accessRoleId: ROLE_ID, accessRoleName: 'Office Staff', isFullAdmin: false });
      const insert = userCalls().find(([sql]) => /INSERT INTO users/.test(sql));
      expect(insert[1][6]).toBe(ROLE_ID);
    });

    it("refuses an access role from another school", async () => {
      mockQueryResponse([]); // not in this school
      const res = await authenticatedRequest('post', '/api/admin/users')
        .send({ firstName: 'A', lastName: 'B', email: 'new@test.com', role: 'TEACHER', accessRoleId: ROLE_ID });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Unknown access role');
    });

    it('refuses an access role on a parent', async () => {
      const res = await authenticatedRequest('post', '/api/admin/users')
        .send({ firstName: 'A', lastName: 'B', email: 'new@test.com', role: 'PARENT', accessRoleId: ROLE_ID });
      expect(res.status).toBe(400);
    });
  });

  describe('edit', () => {
    it('lets a users holder edit a teacher', async () => {
      asOffice();
      mockQueryResponse([target()]);
      mockQueryResponse([target({ first_name: 'Tessa' })]);
      const res = await authenticatedRequest('patch', `/api/admin/users/${TEST_TEACHER_USER_ID}`).send(edit({ firstName: 'Tessa' }));
      expect(res.status).toBe(200);
      expect(store.invalidateUser).toHaveBeenCalledWith(TEST_TEACHER_USER_ID);
    });

    it('refuses promoting a teacher to admin', async () => {
      asOffice();
      mockQueryResponse([target()]);
      const res = await authenticatedRequest('patch', `/api/admin/users/${TEST_TEACHER_USER_ID}`).send(edit({ role: 'ADMIN' }));
      expect(res.status).toBe(403);
      expect(userCalls().some(([sql]) => /UPDATE users/.test(sql))).toBe(false);
    });

    it('refuses editing a full admin', async () => {
      asOffice();
      mockQueryResponse([target({ role: 'ADMIN' })]);
      const res = await authenticatedRequest('patch', `/api/admin/users/${TEST_TEACHER_USER_ID}`).send(edit({ role: 'ADMIN' }));
      expect(res.status).toBe(403);
    });

    it('refuses changing an access role', async () => {
      asOffice();
      mockQueryResponse([target()]);
      mockQueryResponse([{ role_id: ROLE_ID, name: 'Office Staff' }]);
      const res = await authenticatedRequest('patch', `/api/admin/users/${TEST_TEACHER_USER_ID}`).send(edit({ accessRoleId: ROLE_ID }));
      expect(res.status).toBe(403);
    });

    it('lets a full admin give and clear an access role', async () => {
      mockQueryResponse([target()]);
      mockQueryResponse([{ role_id: ROLE_ID, name: 'Office Staff' }]);
      mockQueryResponse([target({ staff_role_id: ROLE_ID, staff_role_name: 'Office Staff' })]);
      const give = await authenticatedRequest('patch', `/api/admin/users/${TEST_TEACHER_USER_ID}`).send(edit({ accessRoleId: ROLE_ID }));
      expect(give.status).toBe(200);
      expect(give.body.data.accessRoleName).toBe('Office Staff');
      const update = userCalls().find(([sql]) => /UPDATE users/.test(sql));
      expect(update[1].slice(7)).toEqual([true, ROLE_ID]);

      db.query.mockClear();
      mockQueryResponse([target({ staff_role_id: ROLE_ID })]);
      mockQueryResponse([target()]);
      const clear = await authenticatedRequest('patch', `/api/admin/users/${TEST_TEACHER_USER_ID}`).send(edit({ accessRoleId: null }));
      expect(clear.status).toBe(200);
      expect(userCalls().find(([sql]) => /UPDATE users/.test(sql))[1].slice(7)).toEqual([true, null]);
    });

    it('keeps the access role when none is sent', async () => {
      mockQueryResponse([target({ staff_role_id: ROLE_ID })]);
      mockQueryResponse([target({ staff_role_id: ROLE_ID })]);
      await authenticatedRequest('patch', `/api/admin/users/${TEST_TEACHER_USER_ID}`).send(edit());
      expect(userCalls().find(([sql]) => /UPDATE users/.test(sql))[1].slice(7)).toEqual([false, null]);
    });

    it('drops the access role when someone becomes a parent', async () => {
      mockQueryResponse([target({ staff_role_id: ROLE_ID })]);
      mockQueryResponse([target({ role: 'PARENT' })]);
      await authenticatedRequest('patch', `/api/admin/users/${TEST_TEACHER_USER_ID}`).send(edit({ role: 'PARENT' }));
      expect(userCalls().find(([sql]) => /UPDATE users/.test(sql))[1].slice(7)).toEqual([true, null]);
    });
  });

  describe('archive, restore, delete, resend', () => {
    it.each([
      ['post', 'archive'],
      ['post', 'unarchive'],
      ['delete', ''],
      ['post', 'resend-invite'],
    ])('refuses %s %s on a full admin', async (method, action) => {
      asOffice();
      mockQueryResponse([target({ role: 'ADMIN', is_archived: action === 'unarchive', invite_pending: true })]);
      const url = `/api/admin/users/${TEST_TEACHER_USER_ID}${action ? `/${action}` : ''}`;
      const res = await authenticatedRequest(method, url);
      expect(res.status).toBe(403);
      expect(userCalls()).toHaveLength(1); // only the target lookup
    });

    it('lets a users holder archive a restricted admin', async () => {
      asOffice();
      mockQueryResponse([target({ role: 'ADMIN', staff_role_id: ROLE_ID })]);
      mockQueryResponse([]); // no active year: no blockers
      mockQueryResponse([target({ role: 'ADMIN', staff_role_id: ROLE_ID, is_archived: true })]);
      mockQueryResponse([]); // tokens
      const res = await authenticatedRequest('post', `/api/admin/users/${TEST_TEACHER_USER_ID}/archive`);
      expect(res.status).toBe(200);
      expect(store.invalidateUser).toHaveBeenCalledWith(TEST_TEACHER_USER_ID);
    });
  });
});
