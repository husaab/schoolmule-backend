// RBAC on /api/classes: lists are scoped, the gradebook and changes are per class.
const { authenticatedRequest } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, mockParentUser, TEST_SCHOOL, TEST_ADMIN_USER_ID, TEST_TEACHER_USER_ID } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const { buildClassRow, buildCreateClassBody } = require('../../helpers/factories');
const { giveRole } = require('../../helpers/mockAccess');
const db = require('../../__mocks__/config/database');

const CLASS_ID = '6f1d2c3b-4a59-4e8f-9b1a-2c3d4e5f6a7b';
const OFFICE = ['students', 'report_cards', 'attendance.daily', 'attendance.classes', 'users'];
const guardRow = (fields = {}) => ({ class_id: CLASS_ID, school: TEST_SCHOOL, teacher_id: 'another-teacher', is_co_teacher: false, ...fields });

describe('RBAC on /api/classes', () => {
  it('keeps parents out entirely', async () => {
    const res = await authenticatedRequest('get', '/api/classes', mockParentUser());
    expect(res.status).toBe(403);
  });

  it("shows office staff every class's name but never its gradebook", async () => {
    giveRole(TEST_ADMIN_USER_ID, OFFICE);
    mockQueryResponse([buildClassRow({ class_id: CLASS_ID, teacher_id: 'another-teacher', school: TEST_SCHOOL })]);
    mockQueryResponse([]); // additional teachers
    const list = await authenticatedRequest('get', '/api/classes', mockAdminUser());
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);

    mockQueryResponse([guardRow()]);
    const gradebook = await authenticatedRequest('get', `/api/classes/${CLASS_ID}/assessments`, mockAdminUser());
    expect(gradebook.status).toBe(403);

    mockQueryResponse([guardRow()]);
    mockQueryResponse([]);
    const roster = await authenticatedRequest('get', `/api/classes/${CLASS_ID}/students`, mockAdminUser());
    expect(roster.status).toBe(200);
  });

  it('shows someone with no cross-class area only the classes they teach', async () => {
    giveRole(TEST_TEACHER_USER_ID, ['analytics']);
    mockQueryResponse([
      buildClassRow({ class_id: 'mine', teacher_id: TEST_TEACHER_USER_ID, school: TEST_SCHOOL }),
      buildClassRow({ class_id: 'co', teacher_id: 'someone', school: TEST_SCHOOL }),
      buildClassRow({ class_id: 'theirs', teacher_id: 'someone', school: TEST_SCHOOL }),
    ]);
    mockQueryResponse([{ class_id: 'co', teacher_id: TEST_TEACHER_USER_ID, first_name: 'T', last_name: 'T', email: 't@test.com' }]);
    const res = await authenticatedRequest('get', '/api/classes', mockTeacherUser());
    expect(res.status).toBe(200);
    expect(res.body.data.map((c) => c.classId)).toEqual(['mine', 'co']);
  });

  it('refuses a teacher listing another teacher\'s classes without a cross-class area', async () => {
    giveRole(TEST_TEACHER_USER_ID, []);
    const res = await authenticatedRequest('get', '/api/classes/teacher/id/someone-else', mockTeacherUser());
    expect(res.status).toBe(403);
  });

  it('lets anyone create a class they lead, but not one for another teacher', async () => {
    giveRole(TEST_ADMIN_USER_ID, OFFICE);
    const res = await authenticatedRequest('post', '/api/classes', mockAdminUser())
      .send(buildCreateClassBody({ teacherId: 'another-teacher' }));
    expect(res.status).toBe(403);
  });

  it('refuses changes to a class you do not teach without classes.manage', async () => {
    giveRole(TEST_ADMIN_USER_ID, OFFICE);
    mockQueryResponse([guardRow()]);
    const res = await authenticatedRequest('delete', `/api/classes/${CLASS_ID}`, mockAdminUser());
    expect(res.status).toBe(403);
    expect(db.query.mock.calls.some(([sql]) => /DELETE FROM classes/i.test(sql))).toBe(false);
  });

  it('lets classes.manage enroll students in any class', async () => {
    giveRole(TEST_ADMIN_USER_ID, ['classes.manage']);
    mockQueryResponse([guardRow()]);
    mockQueryResponse([{ class_id: CLASS_ID, student_id: 's1' }]);
    const res = await authenticatedRequest('post', `/api/classes/${CLASS_ID}/students`, mockAdminUser()).send({ studentId: 's1' });
    expect(res.status).not.toBe(403);
  });

  it("stops the class's own teacher handing it to someone else, and ignores a body school", async () => {
    mockQueryResponse([guardRow({ teacher_id: TEST_TEACHER_USER_ID })]);
    const handoff = await authenticatedRequest('patch', `/api/classes/${CLASS_ID}`, mockTeacherUser()).send({ teacherId: 'another-teacher' });
    expect(handoff.status).toBe(403);

    mockQueryResponse([guardRow({ teacher_id: TEST_TEACHER_USER_ID })]);
    mockQueryResponse([buildClassRow({ class_id: CLASS_ID })]);
    const rename = await authenticatedRequest('patch', `/api/classes/${CLASS_ID}`, mockTeacherUser()).send({ subject: 'Art', school: 'PLAYGROUND' });
    expect(rename.status).toBe(200);
    const update = db.query.mock.calls.find(([sql]) => /UPDATE public\.classes/i.test(sql));
    expect(update[1][0]).toBeNull();
  });
});
