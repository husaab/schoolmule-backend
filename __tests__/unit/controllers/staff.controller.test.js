jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildStaffRow } = require('../../helpers/factories');
const { v4: uuidv4 } = require('uuid');

const app = getApp();

function authGet(url) {
  const token = mockAdminUser();
  return request(app).get(url).set('Authorization', `Bearer ${token}`);
}
function authPost(url) {
  const token = mockAdminUser();
  return request(app).post(url).set('Authorization', `Bearer ${token}`);
}
function authPatch(url) {
  const token = mockAdminUser();
  return request(app).patch(url).set('Authorization', `Bearer ${token}`);
}
function authDelete(url) {
  const token = mockAdminUser();
  return request(app).delete(url).set('Authorization', `Bearer ${token}`);
}

describe('Staff Controller', () => {
  // ── getStaffBySchool ──────────────────────────────────────────────
  describe('GET /api/staff', () => {
    it('should return 200 with staff members', async () => {
      const row = buildStaffRow();
      mockQueryResponse([row]);
      const res = await authGet(`/api/staff?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].staffId).toBe(row.staff_id);
      expect(res.body.data[0].fullName).toBe(row.full_name);
    });

    it('should return 200 with empty array when no staff', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/staff?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('should return 400 when school is missing', async () => {
      const res = await authGet('/api/staff');
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
      expect(res.body.message).toMatch(/school/i);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/staff?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getStaffById ──────────────────────────────────────────────
  describe('GET /api/staff/:staffId', () => {
    it('should return 200 with staff data', async () => {
      const row = buildStaffRow();
      mockQueryResponse([row]);
      const res = await authGet(`/api/staff/${row.staff_id}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.staffId).toBe(row.staff_id);
      expect(res.body.data.staffRole).toBe(row.staff_role);
    });

    it('should return 404 when staff member not found', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/staff/${uuidv4()}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/staff/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── createStaff ──────────────────────────────────────────────
  describe('POST /api/staff', () => {
    it('should return 201 on successful creation', async () => {
      const row = buildStaffRow();
      mockQueryResponse([row]);
      const res = await authPost('/api/staff').send({
        school: TEST_SCHOOL,
        fullName: 'Jane Doe',
        staffRole: 'Vice Principal',
        teachingAssignments: 'Grade 5 Math',
        homeroomGrade: 5,
        email: 'jane@school.com',
        phone: '555-0200',
        preferredContact: 'email',
        phoneContactHours: '9am-3pm',
        emailContactHours: '8am-5pm',
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.staffId).toBe(row.staff_id);
    });

    it('should return 400 when required fields are missing', async () => {
      const res = await authPost('/api/staff').send({ school: TEST_SCHOOL });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
      expect(res.body.message).toMatch(/fullName/);
    });

    it('should return 400 when school is missing', async () => {
      const res = await authPost('/api/staff').send({
        fullName: 'Jane',
        staffRole: 'Teacher',
      });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('insert failed');
      const res = await authPost('/api/staff').send({
        school: TEST_SCHOOL,
        fullName: 'Jane Doe',
        staffRole: 'Vice Principal',
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── updateStaff ──────────────────────────────────────────────
  describe('PATCH /api/staff/:staffId', () => {
    it('should return 200 on successful update', async () => {
      const row = buildStaffRow({ full_name: 'Updated Name' });
      mockQueryResponse([row]);
      const res = await authPatch(`/api/staff/${row.staff_id}`).send({
        school: TEST_SCHOOL,
        fullName: 'Updated Name',
        staffRole: 'Principal',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.fullName).toBe('Updated Name');
    });

    it('should return 400 when school is missing', async () => {
      const res = await authPatch(`/api/staff/${uuidv4()}`).send({
        fullName: 'Updated',
      });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 404 when staff not found', async () => {
      mockQueryResponse([]);
      const res = await authPatch(`/api/staff/${uuidv4()}`).send({
        school: TEST_SCHOOL,
        fullName: 'Updated',
      });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('update failed');
      const res = await authPatch(`/api/staff/${uuidv4()}`).send({
        school: TEST_SCHOOL,
        fullName: 'Updated',
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── deleteStaff ──────────────────────────────────────────────
  describe('DELETE /api/staff/:staffId', () => {
    it('should return 200 on successful deletion', async () => {
      const row = buildStaffRow();
      mockQueryResponse([row]);
      const res = await authDelete(`/api/staff/${row.staff_id}`).send({
        school: TEST_SCHOOL,
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toMatch(/deleted/i);
    });

    it('should return 400 when school is missing', async () => {
      const res = await authDelete(`/api/staff/${uuidv4()}`).send({});
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 404 when staff not found', async () => {
      mockQueryResponse([]);
      const res = await authDelete(`/api/staff/${uuidv4()}`).send({
        school: TEST_SCHOOL,
      });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('delete failed');
      const res = await authDelete(`/api/staff/${uuidv4()}`).send({
        school: TEST_SCHOOL,
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });
});
