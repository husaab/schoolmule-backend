jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { authenticatedRequest } = require('../../helpers/testApp');
const { TEST_TEACHER_USER_ID, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const { buildUserRow } = require('../../helpers/factories');
const db = require('../../__mocks__/config/database');
const adminUserQueries = require('../../../queries/adminUser.queries');

describe('GET /api/admin/users/:id', () => {
  it("lists a teacher's linked children, so the admin can see they are also a parent", async () => {
    mockQueryResponse([buildUserRow({ user_id: TEST_TEACHER_USER_ID, role: 'TEACHER' })]); // selectUserInSchool
    mockQueryResponse([]); // classes
    mockQueryResponse([]); // homeroom
    mockQueryResponse([]); // staff profile
    mockQueryResponse([{ student_id: 's1', name: 'Mahdiya Fatima', grade: '6', relation: 'Mother' }]); // children
    mockQueryResponse([]); // archive blockers

    const res = await authenticatedRequest('get', `/api/admin/users/${TEST_TEACHER_USER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.data.children).toEqual([{ studentId: 's1', name: 'Mahdiya Fatima', grade: '6', relation: 'Mother' }]);
    expect(db.query).toHaveBeenCalledWith(adminUserQueries.selectChildrenForParent, [TEST_TEACHER_USER_ID, TEST_SCHOOL]);
  });
});
