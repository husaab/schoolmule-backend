// RBAC D8: anyone on staff builds and manages their own forms; `forms` opens all.
const { authenticatedRequest } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, mockParentUser, TEST_ADMIN_USER_ID, TEST_TEACHER_USER_ID, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const { giveRole } = require('../../helpers/mockAccess');
const db = require('../../__mocks__/config/database');

const FORM = '0d5a6b7c-8d9e-4f01-a2b3-c4d5e6f70819';
const SUB = '1e6b7c8d-9e0f-4a12-b3c4-d5e6f7081920';
const formCalls = () => db.query.mock.calls.filter(([sql]) => !/FROM school_years|access:form/.test(sql));

describe('form access', () => {
  it('keeps parents out', async () => {
    expect((await authenticatedRequest('get', '/api/registration/forms', mockParentUser())).status).toBe(403);
  });

  it("lists only a teacher's own forms", async () => {
    mockQueryResponse([]);
    const res = await authenticatedRequest('get', '/api/registration/forms', mockTeacherUser());
    expect(res.status).toBe(200);
    expect(formCalls()[0][1]).toEqual([TEST_SCHOOL, TEST_TEACHER_USER_ID]);
  });

  it('lists every form with the forms permission', async () => {
    mockQueryResponse([]);
    await authenticatedRequest('get', '/api/registration/forms', mockAdminUser());
    expect(formCalls()[0][1]).toEqual([TEST_SCHOOL, null]);
  });

  it("opens a teacher's own form and refuses someone else's", async () => {
    mockQueryResponse([{ created_by: TEST_TEACHER_USER_ID }]);
    mockQueryResponse([]); // the form itself (not found is fine: the guard passed)
    const own = await authenticatedRequest('get', `/api/registration/forms/${FORM}`, mockTeacherUser());
    expect(own.status).not.toBe(403);

    mockQueryResponse([{ created_by: 'someone-else' }]);
    const other = await authenticatedRequest('put', `/api/registration/forms/${FORM}`, mockTeacherUser()).send({ title: 'x' });
    expect(other.status).toBe(403);
  });

  it("refuses a submission of someone else's form even through your own form's URL", async () => {
    mockQueryResponse([{ created_by: 'someone-else' }]);
    const res = await authenticatedRequest('get', `/api/registration/forms/${FORM}/submissions/${SUB}`, mockTeacherUser());
    expect(res.status).toBe(403);
  });

  it('404s a form of another school (or a missing one)', async () => {
    mockQueryResponse([]);
    const res = await authenticatedRequest('delete', `/api/registration/forms/${FORM}`, mockTeacherUser());
    expect(res.status).toBe(404);
  });

  it('keeps sheets, statuses and imports for forms holders', async () => {
    const sheet = await authenticatedRequest('put', `/api/registration/forms/${FORM}/sheet`, mockTeacherUser()).send({});
    expect(sheet.status).toBe(403);
    const status = await authenticatedRequest('post', '/api/registration/statuses', mockTeacherUser()).send({ label: 'x' });
    expect(status.status).toBe(403);

    giveRole(TEST_ADMIN_USER_ID, ['forms']);
    const imp = await authenticatedRequest('post', `/api/registration/forms/${FORM}/import/execute`, mockAdminUser()).send({});
    expect(imp.status).toBe(403); // importing creates students: needs students too
  });
});
