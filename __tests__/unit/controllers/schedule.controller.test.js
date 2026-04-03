jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildScheduleRow } = require('../../helpers/factories');
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

describe('Schedule Controller', () => {
  // ── getAllSchedules ──────────────────────────────────────────────
  describe('GET /api/schedules', () => {
    it('should return 200 with schedules', async () => {
      const row = buildScheduleRow();
      mockQueryResponse([row]);
      const res = await authGet(`/api/schedules?school=${TEST_SCHOOL}&week=2025-10-13`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    it('should return 200 with empty array when no schedules', async () => {
      mockQueryResponse([]);
      const res = await authGet(`/api/schedules?school=${TEST_SCHOOL}&week=2025-10-13`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('should return 400 when school is missing', async () => {
      const res = await authGet('/api/schedules?week=2025-10-13');
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when week is missing', async () => {
      const res = await authGet(`/api/schedules?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/schedules?school=${TEST_SCHOOL}&week=2025-10-13`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getSchedulesByGrade ──────────────────────────────────────────────
  describe('GET /api/schedules/grade/:grade', () => {
    it('should return 200 with schedules for the grade', async () => {
      const row = buildScheduleRow({ grade: 5 });
      mockQueryResponse([row]);
      const res = await authGet(`/api/schedules/grade/5?school=${TEST_SCHOOL}&week=2025-10-13`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    it('should return 400 when school is missing', async () => {
      const res = await authGet('/api/schedules/grade/5?week=2025-10-13');
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when week is missing', async () => {
      const res = await authGet(`/api/schedules/grade/5?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/schedules/grade/5?school=${TEST_SCHOOL}&week=2025-10-13`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── createSchedule ──────────────────────────────────────────────
  describe('POST /api/schedules', () => {
    it('should return 201 on successful creation', async () => {
      const row = buildScheduleRow();
      mockQueryResponse([row]);
      const res = await authPost('/api/schedules').send({
        school: TEST_SCHOOL,
        grade: 5,
        day_of_week: 'Monday',
        start_time: '09:00',
        end_time: '09:45',
        subject: 'Mathematics',
        teacher_name: 'Teacher User',
        is_lunch: false,
        lunch_supervisor: null,
        week_start_date: '2025-10-13',
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when required fields are missing', async () => {
      const res = await authPost('/api/schedules').send({
        school: TEST_SCHOOL,
        grade: 5,
      });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 400 when school is missing', async () => {
      const res = await authPost('/api/schedules').send({
        day_of_week: 'Monday',
        start_time: '09:00',
        end_time: '09:45',
        week_start_date: '2025-10-13',
      });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('insert failed');
      const res = await authPost('/api/schedules').send({
        school: TEST_SCHOOL,
        grade: 5,
        day_of_week: 'Monday',
        start_time: '09:00',
        end_time: '09:45',
        subject: 'Mathematics',
        teacher_name: 'Teacher User',
        is_lunch: false,
        lunch_supervisor: null,
        week_start_date: '2025-10-13',
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── updateSchedule ──────────────────────────────────────────────
  describe('PATCH /api/schedules/:id', () => {
    it('should return 200 on successful update', async () => {
      const row = buildScheduleRow({ subject: 'Science' });
      mockQueryResponse([row], 1);
      const res = await authPatch(`/api/schedules/${row.schedule_id}`).send({
        school: TEST_SCHOOL,
        grade: 5,
        day_of_week: 'Monday',
        start_time: '09:00',
        end_time: '09:45',
        subject: 'Science',
        teacher_name: 'Teacher User',
        is_lunch: false,
        lunch_supervisor: null,
        week_start_date: '2025-10-13',
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 404 when schedule not found', async () => {
      mockQueryResponse([], 0);
      const res = await authPatch(`/api/schedules/${uuidv4()}`).send({
        school: TEST_SCHOOL,
        grade: 5,
        day_of_week: 'Monday',
        start_time: '09:00',
        end_time: '09:45',
        subject: 'Science',
        teacher_name: 'Teacher User',
        is_lunch: false,
        lunch_supervisor: null,
        week_start_date: '2025-10-13',
      });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('update failed');
      const res = await authPatch(`/api/schedules/${uuidv4()}`).send({
        school: TEST_SCHOOL,
        grade: 5,
        day_of_week: 'Monday',
        start_time: '09:00',
        end_time: '09:45',
        subject: 'Science',
        teacher_name: 'Teacher User',
        is_lunch: false,
        lunch_supervisor: null,
        week_start_date: '2025-10-13',
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── deleteSchedule ──────────────────────────────────────────────
  describe('DELETE /api/schedules/:id', () => {
    it('should return 200 on successful deletion', async () => {
      mockQueryResponse([], 1);
      const res = await authDelete(`/api/schedules/${uuidv4()}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toMatch(/deleted/i);
    });

    it('should return 404 when schedule not found', async () => {
      mockQueryResponse([], 0);
      const res = await authDelete(`/api/schedules/${uuidv4()}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('delete failed');
      const res = await authDelete(`/api/schedules/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });
});
