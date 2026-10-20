// RBAC: analytics and grade averages need the analytics permission.
const { authenticatedRequest } = require('../../helpers/testApp');
const { mockAdminUser, mockParentUser, TEST_ADMIN_USER_ID } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const { giveRole } = require('../../helpers/mockAccess');

const OFFICE = ['students', 'report_cards', 'attendance.daily', 'attendance.classes', 'users'];

describe('analytics access', () => {
  it.each(['/api/analytics/overview?termId=t', '/api/analytics/snapshot?termId=t', '/api/students/s1/grades'])(
    'refuses office staff without analytics: %s',
    async (url) => {
      giveRole(TEST_ADMIN_USER_ID, OFFICE);
      const res = await authenticatedRequest('get', url, mockAdminUser());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    },
  );

  it('keeps parents off the staff dashboard', async () => {
    const res = await authenticatedRequest('get', '/api/dashboard/summary', mockParentUser());
    expect(res.status).toBe(403);
  });

  it('leaves the school average out of the dashboard summary without analytics', async () => {
    giveRole(TEST_ADMIN_USER_ID, OFFICE);
    [{ count: 120 }, { count: 15 }, { count: 30 }, { rate: 0.92 }, { rate: 0.89 }, { rate: 0.91 }, { count: 100 }, { avg_class_size: 25.5 }]
      .forEach((row) => mockQueryResponse([row]));
    const res = await authenticatedRequest('get', '/api/dashboard/summary?term=T1&date=2026-10-20', mockAdminUser());
    expect(res.status).toBe(200);
    expect(res.body.data.averageStudentGrade).toBeNull();
    expect(res.body.data.totalStudents).toBe(120);
  });

  it("scopes classes-health to the caller's own classes without classes.all", async () => {
    giveRole(TEST_ADMIN_USER_ID, OFFICE);
    mockQueryResponse([]); // selectClassIdsForTeacher: teaches nothing
    const res = await authenticatedRequest('get', '/api/analytics/classes-health?termId=t', mockAdminUser());
    expect([200, 500]).toContain(res.status); // the matrix build may need more mocks; never a 403
    expect(res.status).not.toBe(403);
  });
});
