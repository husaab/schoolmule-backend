const { authenticatedRequest } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, TEST_ADMIN_USER_ID } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockPgError } = require('../../helpers/mockDb');
const { giveRole } = require('../../helpers/mockAccess');
const store = require('../../../services/access/accessStore');
const db = require('../../__mocks__/config/database');

const ROLE_ID = '9b0c1e9a-1d2f-4c6b-8a77-2b9d0e5f4a10';
// resolveSchoolYear answers its own school_years lookup first; these are the
// controller's queries.
const roleCalls = () => db.query.mock.calls.filter(([sql]) => !/FROM school_years/.test(sql));

const roleRow = (fields = {}) => ({
  role_id: ROLE_ID, name: 'Office Staff', description: '', permissions: ['students', 'forms'],
  user_count: 0, created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z', ...fields,
});

describe('Roles API (/api/admin/roles)', () => {
  describe('who may use it', () => {
    it('refuses a teacher', async () => {
      const res = await authenticatedRequest('get', '/api/admin/roles', mockTeacherUser());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FULL_ADMIN_REQUIRED');
    });

    it('refuses a restricted admin, even one who manages users', async () => {
      giveRole(TEST_ADMIN_USER_ID, ['users']);
      const res = await authenticatedRequest('post', '/api/admin/roles', mockAdminUser()).send({ name: 'X', permissions: [] });
      expect(res.status).toBe(403);
      expect(roleCalls()).toHaveLength(0);
    });
  });

  it('returns the catalog', async () => {
    const res = await authenticatedRequest('get', '/api/admin/roles/catalog');
    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toHaveLength(15);
    expect(res.body.data.presets[0].name).toBe('Office Staff');
  });

  it('lists custom roles with the built-ins and their counts', async () => {
    mockQueryResponse([roleRow({ user_count: 1 })]);
    mockQueryResponse([{ admins: 2, teachers: 9 }]);
    const res = await authenticatedRequest('get', '/api/admin/roles');
    expect(res.status).toBe(200);
    expect(res.body.data.roles[0]).toMatchObject({ roleId: ROLE_ID, name: 'Office Staff', userCount: 1 });
    expect(res.body.data.builtIns.map((b) => [b.id, b.userCount])).toEqual([['admin', 2], ['teacher', 9]]);
  });

  describe('create', () => {
    it('creates a role, school from the token, keys in catalog order', async () => {
      mockQueryResponse([roleRow({ permissions: ['students', 'forms'] })]);
      const res = await authenticatedRequest('post', '/api/admin/roles')
        .send({ name: '  Office Staff ', permissions: ['forms', 'students'], school: 'PLAYGROUND' });
      expect(res.status).toBe(201);
      const [, params] = roleCalls()[0];
      expect(params).toEqual(['ALHAADIACADEMY', 'Office Staff', '', ['students', 'forms'], TEST_ADMIN_USER_ID]);
      expect(store.invalidateAll).toHaveBeenCalled();
    });

    it.each([
      [{ permissions: [] }, 'A role needs a name'],
      [{ name: 'Teacher', permissions: [] }, 'built-in'],
      [{ name: 'x'.repeat(61), permissions: [] }, '60 characters'],
      [{ name: 'Ok', permissions: 'forms' }, 'must be a list'],
    ])('refuses %j', async (body, message) => {
      const res = await authenticatedRequest('post', '/api/admin/roles').send(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain(message);
    });

    it('names unknown permission keys', async () => {
      const res = await authenticatedRequest('post', '/api/admin/roles').send({ name: 'Ok', permissions: ['forms', 'roles.manage'] });
      expect(res.status).toBe(400);
      expect(res.body.unknown).toEqual(['roles.manage']);
    });

    it('refuses a duplicate name', async () => {
      mockPgError('23505');
      const res = await authenticatedRequest('post', '/api/admin/roles').send({ name: 'Office Staff', permissions: [] });
      expect(res.status).toBe(409);
    });
  });

  describe('update', () => {
    it('updates only what was sent and refreshes holders', async () => {
      mockQueryResponse([roleRow({ permissions: ['forms'] })]);
      const res = await authenticatedRequest('patch', `/api/admin/roles/${ROLE_ID}`).send({ permissions: ['forms'] });
      expect(res.status).toBe(200);
      expect(roleCalls()[0][1]).toEqual([ROLE_ID, 'ALHAADIACADEMY', null, null, ['forms']]);
      expect(store.invalidateAll).toHaveBeenCalled();
    });

    it('404s a role from another school', async () => {
      mockQueryResponse([]);
      const res = await authenticatedRequest('patch', `/api/admin/roles/${ROLE_ID}`).send({ name: 'New' });
      expect(res.status).toBe(404);
    });

    it('404s a malformed id without a query', async () => {
      const res = await authenticatedRequest('patch', '/api/admin/roles/nope').send({ name: 'New' });
      expect(res.status).toBe(404);
      expect(roleCalls()).toHaveLength(0);
    });
  });

  describe('delete', () => {
    it('refuses while anyone holds it', async () => {
      mockQueryResponse([{ count: 2 }]);
      const res = await authenticatedRequest('delete', `/api/admin/roles/${ROLE_ID}`);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'ROLE_IN_USE', userCount: 2 });
    });

    it('deletes an unused role', async () => {
      mockQueryResponse([{ count: 0 }]);
      mockQueryResponse([], 1);
      const res = await authenticatedRequest('delete', `/api/admin/roles/${ROLE_ID}`);
      expect(res.status).toBe(200);
      expect(roleCalls()[1][1]).toEqual([ROLE_ID, 'ALHAADIACADEMY']);
    });

    it('answers the race where someone got the role in between', async () => {
      mockQueryResponse([{ count: 0 }]);
      mockPgError('23503');
      mockQueryResponse([{ count: 1 }]);
      const res = await authenticatedRequest('delete', `/api/admin/roles/${ROLE_ID}`);
      expect(res.status).toBe(409);
      expect(res.body.userCount).toBe(1);
    });
  });

  it('lists who holds a role', async () => {
    mockQueryResponse([roleRow()]);
    mockQueryResponse([{ user_id: 'u9', first_name: 'Office', last_name: 'Tester', email: 'office@test.com', role: 'ADMIN', is_archived: false }]);
    const res = await authenticatedRequest('get', `/api/admin/roles/${ROLE_ID}/users`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ userId: 'u9', fullName: 'Office Tester', email: 'office@test.com', role: 'ADMIN', isArchived: false }]);
  });
});
