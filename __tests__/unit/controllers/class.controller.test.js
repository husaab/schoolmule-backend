jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL, TEST_TEACHER_USER_ID } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError, mockTransactionSequence, mockTransactionError } = require('../../helpers/mockDb');
const {
  buildClassRow,
  buildStudentRow,
  buildAssessmentRow,
  buildCreateClassBody,
  buildClassTeacherRow,
} = require('../../helpers/factories');
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

describe('Class Controller', () => {
  // ── getAllClasses ──────────────────────────────────────────────
  describe('GET /api/classes', () => {
    it('should return 200 with classes', async () => {
      const row = buildClassRow();
      // First query: selectClassesBySchool
      mockQueryResponse([row]);
      // Second query: batchFetchAdditionalTeachers (empty)
      mockQueryResponse([]);
      const res = await authGet(`/api/classes?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].classId).toBe(row.class_id);
    });

    it('should return 400 when school is missing', async () => {
      const res = await authGet('/api/classes');
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/classes?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getClassById ──────────────────────────────────────────────
  describe('GET /api/classes/:id', () => {
    it('should return 200 with the class', async () => {
      const row = buildClassRow();
      // selectClassById
      mockQueryResponse([row]);
      // fetchAdditionalTeachers
      mockQueryResponse([]);
      const res = await authGet(`/api/classes/${row.class_id}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.classId).toBe(row.class_id);
    });

    it('should return 400 for invalid UUID', async () => {
      const res = await authGet('/api/classes/not-a-uuid');
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('error');
    });

    it('should return 404 when class not found', async () => {
      const id = uuidv4();
      mockQueryResponse([]);
      const res = await authGet(`/api/classes/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      const id = uuidv4();
      mockQueryError('DB error');
      const res = await authGet(`/api/classes/${id}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getClassesByGrade ──────────────────────────────────────────────
  describe('GET /api/classes/grade/:grade', () => {
    it('should return 200 with classes for the grade', async () => {
      const row = buildClassRow({ grade: 5 });
      mockQueryResponse([row]);
      mockQueryResponse([]);
      const res = await authGet(`/api/classes/grade/5?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when school is missing', async () => {
      const res = await authGet('/api/classes/grade/5');
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/classes/grade/5?school=${TEST_SCHOOL}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getClassesByTeacher ──────────────────────────────────────────────
  describe('GET /api/classes/teacher/:teacherName', () => {
    it('should return 200 with classes for the teacher', async () => {
      const row = buildClassRow({ teacher_name: 'Teacher User' });
      mockQueryResponse([row]);
      mockQueryResponse([]);
      const res = await authGet('/api/classes/teacher/Teacher%20User');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet('/api/classes/teacher/Teacher%20User');
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getClassesByTeacherId ──────────────────────────────────────────────
  describe('GET /api/classes/teacher/id/:teacherId', () => {
    it('should return 200 with classes for teacher id', async () => {
      const row = buildClassRow({ teacher_id: TEST_TEACHER_USER_ID });
      mockQueryResponse([row]);
      mockQueryResponse([]);
      const res = await authGet(`/api/classes/teacher/id/${TEST_TEACHER_USER_ID}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/classes/teacher/id/${TEST_TEACHER_USER_ID}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── createClass ──────────────────────────────────────────────
  describe('POST /api/classes', () => {
    it('should return 201 on successful creation', async () => {
      const row = buildClassRow();
      mockQueryResponse([row]);
      const body = buildCreateClassBody();
      const res = await authPost('/api/classes').send(body);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.classId).toBe(row.class_id);
    });

    it('should return 400 when required fields are missing', async () => {
      const res = await authPost('/api/classes').send({ school: TEST_SCHOOL });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('insert failed');
      const body = buildCreateClassBody();
      const res = await authPost('/api/classes').send(body);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── updateClass ──────────────────────────────────────────────
  describe('PATCH /api/classes/:id', () => {
    it('should return 200 on successful update', async () => {
      const row = buildClassRow({ subject: 'Science' });
      mockQueryResponse([row], 1);
      const id = row.class_id;
      const res = await authPatch(`/api/classes/${id}`).send({ subject: 'Science' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 404 when class not found', async () => {
      mockQueryResponse([], 0);
      const res = await authPatch(`/api/classes/${uuidv4()}`).send({ subject: 'Science' });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('update failed');
      const res = await authPatch(`/api/classes/${uuidv4()}`).send({ subject: 'Science' });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── deleteClass ──────────────────────────────────────────────
  describe('DELETE /api/classes/:id', () => {
    it('should return 200 on successful deletion', async () => {
      mockQueryResponse([], 1);
      const res = await authDelete(`/api/classes/${uuidv4()}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 404 when class not found', async () => {
      mockQueryResponse([], 0);
      const res = await authDelete(`/api/classes/${uuidv4()}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('delete failed');
      const res = await authDelete(`/api/classes/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getStudentsInClass ──────────────────────────────────────────────
  describe('GET /api/classes/:classId/students', () => {
    it('should return 200 with students', async () => {
      const student = buildStudentRow();
      mockQueryResponse([student]);
      const res = await authGet(`/api/classes/${uuidv4()}/students`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/classes/${uuidv4()}/students`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── getAssessmentsByClass ──────────────────────────────────────────────
  describe('GET /api/classes/:classId/assessments', () => {
    it('should return 200 with assessments', async () => {
      const assessment = buildAssessmentRow();
      mockQueryResponse([assessment]);
      const res = await authGet(`/api/classes/${uuidv4()}/assessments`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    it('should return 500 on database error', async () => {
      mockQueryError('DB error');
      const res = await authGet(`/api/classes/${uuidv4()}/assessments`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── addStudentToClass ──────────────────────────────────────────────
  describe('POST /api/classes/:classId/students', () => {
    it('should return 201 on successful enrollment', async () => {
      const classId = uuidv4();
      const studentId = uuidv4();
      mockQueryResponse([{ class_id: classId, student_id: studentId }]);
      const res = await authPost(`/api/classes/${classId}/students`).send({ studentId });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.classId).toBe(classId);
    });

    it('should return 400 when studentId is missing', async () => {
      const res = await authPost(`/api/classes/${uuidv4()}/students`).send({});
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 409 on duplicate enrollment', async () => {
      const err = new Error('duplicate key');
      err.code = '23505';
      const db = require('../../__mocks__/config/database');
      db.query.mockRejectedValueOnce(err);
      const res = await authPost(`/api/classes/${uuidv4()}/students`).send({
        studentId: uuidv4(),
      });
      expect(res.status).toBe(409);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('insert failed');
      const res = await authPost(`/api/classes/${uuidv4()}/students`).send({
        studentId: uuidv4(),
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── removeStudentFromClass ──────────────────────────────────────────────
  describe('DELETE /api/classes/:classId/students/:studentId', () => {
    it('should return 200 on successful removal', async () => {
      mockQueryResponse([], 1);
      const res = await authDelete(`/api/classes/${uuidv4()}/students/${uuidv4()}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 404 when enrollment not found', async () => {
      mockQueryResponse([], 0);
      const res = await authDelete(`/api/classes/${uuidv4()}/students/${uuidv4()}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('delete failed');
      const res = await authDelete(`/api/classes/${uuidv4()}/students/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── bulkEnrollStudentsToClass ──────────────────────────────────────────────
  describe('POST /api/classes/:classId/students/bulk', () => {
    it('should return 201 when enrolling specific students', async () => {
      const classId = uuidv4();
      const sid1 = uuidv4();
      const sid2 = uuidv4();
      // enrollSpecificStudents
      mockQueryResponse([]);
      // selectEnrolledSpecificStudents
      mockQueryResponse([{ student_id: sid1 }, { student_id: sid2 }]);
      const res = await authPost(`/api/classes/${classId}/students/bulk`).send({
        studentIds: [sid1, sid2],
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);
    });

    it('should return 201 when enrolling all in grade', async () => {
      const classId = uuidv4();
      const classRow = buildClassRow({ class_id: classId, grade: 5 });
      const sid = uuidv4();
      // selectClassById
      mockQueryResponse([classRow]);
      // enrollAllInGrade
      mockQueryResponse([]);
      // selectStudentsByGrade
      mockQueryResponse([{ student_id: sid }]);
      // selectEnrolledSpecificStudents
      mockQueryResponse([{ student_id: sid }]);
      const res = await authPost(`/api/classes/${classId}/students/bulk`).send({
        enrollAllInGrade: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when studentIds is empty and enrollAllInGrade is false', async () => {
      const res = await authPost(`/api/classes/${uuidv4()}/students/bulk`).send({
        studentIds: [],
      });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 404 when class not found for enrollAllInGrade', async () => {
      mockQueryResponse([]);
      const res = await authPost(`/api/classes/${uuidv4()}/students/bulk`).send({
        enrollAllInGrade: true,
      });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('bulk error');
      const res = await authPost(`/api/classes/${uuidv4()}/students/bulk`).send({
        studentIds: [uuidv4()],
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── bulkUnenrollStudentsFromClass ──────────────────────────────────────────────
  describe('POST /api/classes/:classId/students/bulk-unenroll', () => {
    it('should return 200 on successful bulk unenrollment', async () => {
      mockQueryResponse([], 5);
      const res = await authPost(`/api/classes/${uuidv4()}/students/bulk-unenroll`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('unenroll error');
      const res = await authPost(`/api/classes/${uuidv4()}/students/bulk-unenroll`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── duplicateClass ──────────────────────────────────────────────
  describe('POST /api/classes/:sourceClassId/duplicate', () => {
    it('should return 201 on successful duplication', async () => {
      const sourceId = uuidv4();
      const sourceRow = buildClassRow({ class_id: sourceId });
      const newRow = buildClassRow();

      // Transaction: BEGIN, selectClassById, createClass, duplicateSelectAssessments,
      // duplicateSelectStudents, duplicateSelectClassTeachers, COMMIT
      mockTransactionSequence([
        { rows: [sourceRow] },               // selectClassById
        { rows: [newRow] },                   // createClass
        { rows: [] },                         // duplicateSelectAssessments (no assessments)
        { rows: [] },                         // duplicateSelectStudents (no students)
        { rows: [] },                         // duplicateSelectClassTeachers (no additional teachers)
      ]);

      const res = await authPost(`/api/classes/${sourceId}/duplicate`).send({
        grade: 5,
        subject: 'Science',
        teacherName: 'Teacher User',
        teacherId: TEST_TEACHER_USER_ID,
        termId: uuidv4(),
        termName: 'Term 2 2025-2026',
      });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.classId).toBe(newRow.class_id);
    });

    it('should return 400 for invalid source class ID format', async () => {
      const res = await authPost('/api/classes/not-a-uuid/duplicate').send({
        grade: 5,
        subject: 'Science',
        teacherName: 'Teacher User',
        teacherId: TEST_TEACHER_USER_ID,
        termId: uuidv4(),
        termName: 'Term 2 2025-2026',
      });
      expect(res.status).toBe(400);
    });

    it('should return 400 when required fields are missing', async () => {
      const res = await authPost(`/api/classes/${uuidv4()}/duplicate`).send({
        grade: 5,
      });
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 404 when source class not found', async () => {
      const sourceId = uuidv4();
      mockTransactionSequence([
        { rows: [] },
      ]);
      const res = await authPost(`/api/classes/${sourceId}/duplicate`).send({
        grade: 5,
        subject: 'Science',
        teacherName: 'Teacher User',
        teacherId: TEST_TEACHER_USER_ID,
        termId: uuidv4(),
        termName: 'Term 2 2025-2026',
      });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on transaction error', async () => {
      mockTransactionError(0, 'tx failed');
      const res = await authPost(`/api/classes/${uuidv4()}/duplicate`).send({
        grade: 5,
        subject: 'Science',
        teacherName: 'Teacher User',
        teacherId: TEST_TEACHER_USER_ID,
        termId: uuidv4(),
        termName: 'Term 2 2025-2026',
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── addTeacherToClass ──────────────────────────────────────────────
  describe('POST /api/classes/:classId/teachers', () => {
    it('should return 201 on successful addition', async () => {
      const classId = uuidv4();
      const teacherId = uuidv4();
      const classRow = buildClassRow({ class_id: classId, teacher_id: TEST_TEACHER_USER_ID });
      // selectClassById
      mockQueryResponse([classRow]);
      // insertClassTeacher
      mockQueryResponse([{ class_id: classId, teacher_id: teacherId, created_at: new Date().toISOString() }]);
      const res = await authPost(`/api/classes/${classId}/teachers`).send({ teacherId });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
    });

    it('should return 400 when teacherId is missing', async () => {
      const res = await authPost(`/api/classes/${uuidv4()}/teachers`).send({});
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 404 when class not found', async () => {
      mockQueryResponse([]);
      const res = await authPost(`/api/classes/${uuidv4()}/teachers`).send({
        teacherId: uuidv4(),
      });
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 409 when adding primary teacher as additional', async () => {
      const classId = uuidv4();
      const classRow = buildClassRow({ class_id: classId, teacher_id: TEST_TEACHER_USER_ID });
      mockQueryResponse([classRow]);
      const res = await authPost(`/api/classes/${classId}/teachers`).send({
        teacherId: TEST_TEACHER_USER_ID,
      });
      expect(res.status).toBe(409);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('insert failed');
      const res = await authPost(`/api/classes/${uuidv4()}/teachers`).send({
        teacherId: uuidv4(),
      });
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });

  // ── removeTeacherFromClass ──────────────────────────────────────────────
  describe('DELETE /api/classes/:classId/teachers/:teacherId', () => {
    it('should return 200 on successful removal', async () => {
      mockQueryResponse([], 1);
      const res = await authDelete(`/api/classes/${uuidv4()}/teachers/${uuidv4()}`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 404 when assignment not found', async () => {
      mockQueryResponse([], 0);
      const res = await authDelete(`/api/classes/${uuidv4()}/teachers/${uuidv4()}`);
      expect(res.status).toBe(404);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      mockQueryError('delete failed');
      const res = await authDelete(`/api/classes/${uuidv4()}/teachers/${uuidv4()}`);
      expect(res.status).toBe(500);
      expect(res.body.status).toBe('failed');
    });
  });
});
