const db = require('../../../config/database'); // mapped to the mock
const { authenticatedRequest } = require('../../helpers/testApp');
const { mockParentUser, mockTeacherUser } = require('../../helpers/mockAuth');

const PARENT = '550e8400-e29b-41d4-a716-446655440002';
const OTHER = '66666666-6666-4666-8666-666666666666';

describe('parent link routes are staff-only except a parent reading their own children', () => {
  beforeEach(() => db._reset());

  it('lets a parent read their own children', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await authenticatedRequest('get', `/api/parent-students/parent/${PARENT}`, mockParentUser());
    expect(res.status).toBe(200);
  });

  it("blocks a parent reading another parent's children", async () => {
    const res = await authenticatedRequest('get', `/api/parent-students/parent/${OTHER}`, mockParentUser());
    expect(res.status).toBe(403);
  });

  it('blocks a parent listing all links, editing or deleting one', async () => {
    expect((await authenticatedRequest('get', '/api/parent-students', mockParentUser())).status).toBe(403);
    expect((await authenticatedRequest('patch', `/api/parent-students/${OTHER}`, mockParentUser()).send({ relation: 'x' })).status).toBe(403);
    expect((await authenticatedRequest('delete', `/api/parent-students/${OTHER}`, mockParentUser())).status).toBe(403);
  });

  it('404s staff reading, editing or deleting a link row from another school', async () => {
    const other = { parent_student_link_id: OTHER, school: 'PLAYGROUND', student_id: 's', parent_id: null, relation: 'Mother' };
    db.query.mockResolvedValueOnce({ rows: [other] });
    expect((await authenticatedRequest('get', `/api/parent-students/${OTHER}`, mockTeacherUser())).status).toBe(404);
    db.query.mockResolvedValueOnce({ rows: [other] });
    expect((await authenticatedRequest('patch', `/api/parent-students/${OTHER}`, mockTeacherUser()).send({ relation: 'x' })).status).toBe(404);
    db.query.mockResolvedValueOnce({ rows: [other] });
    expect((await authenticatedRequest('delete', `/api/parent-students/${OTHER}`, mockTeacherUser())).status).toBe(404);
  });

  it('blocks a parent listing parent accounts, allows staff', async () => {
    expect((await authenticatedRequest('get', '/api/parents', mockParentUser())).status).toBe(403);
    db.query.mockResolvedValueOnce({ rows: [] });
    expect((await authenticatedRequest('get', '/api/parents', mockTeacherUser())).status).toBe(200);
  });
});
