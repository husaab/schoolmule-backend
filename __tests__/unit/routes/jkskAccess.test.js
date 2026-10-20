// RBAC on /api/jk and /api/sk: the JK/SK gradebook belongs to the teachers
// who teach the student; set-up and report generation are report_cards.
const { authenticatedRequest } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, mockParentUser, TEST_ADMIN_USER_ID, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const { giveRole } = require('../../helpers/mockAccess');
const db = require('../../__mocks__/config/database');

const STUDENT = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const studentRow = (fields = {}) => ({ student_id: STUDENT, school: TEST_SCHOOL, taught: false, ...fields });
const controllerCalls = () => db.query.mock.calls.filter(([sql]) => !/FROM school_years|access:students/.test(sql));

describe('RBAC on JK/SK', () => {
  it('keeps parents out', async () => {
    const res = await authenticatedRequest('get', `/api/jk/assessments/${STUDENT}`, mockParentUser());
    expect(res.status).toBe(403);
  });

  it("lets a student's teacher read their ratings", async () => {
    mockQueryResponse([studentRow({ taught: true })]);
    mockQueryResponse([]);
    const res = await authenticatedRequest('get', `/api/jk/assessments/${STUDENT}?term=T1&documentType=report_card`, mockTeacherUser());
    expect(res.status).toBe(200);
  });

  it("keeps another teacher out of a student's ratings", async () => {
    mockQueryResponse([studentRow({ taught: false })]);
    const res = await authenticatedRequest('post', '/api/sk/assessments/bulk', mockTeacherUser())
      .send({ entries: [{ studentId: STUDENT, standardId: 'x', rating: 'E' }] });
    expect(res.status).toBe(403);
    expect(controllerCalls()).toHaveLength(0);
  });

  it('keeps office staff (report cards, no classes.all) out of ratings but lets them generate', async () => {
    giveRole(TEST_ADMIN_USER_ID, ['report_cards', 'students']);
    mockQueryResponse([studentRow()]);
    const rate = await authenticatedRequest('get', `/api/jk/learning-skills/${STUDENT}`, mockAdminUser());
    expect(rate.status).toBe(403);

    mockQueryResponse([studentRow()]);
    const gen = await authenticatedRequest('post', '/api/jk/report-card/generate', mockAdminUser()).send({ term: 'T1' });
    expect(gen.status).not.toBe(403);
  });

  it("never generates for another school's student", async () => {
    mockQueryResponse([studentRow({ school: 'PLAYGROUND' })]);
    const res = await authenticatedRequest('post', '/api/sk/progress-report/generate', mockAdminUser()).send({ studentId: STUDENT, term: 'T1' });
    expect(res.status).toBe(403);
  });

  it('needs report_cards to change the set-up, and pins it to the caller\'s school', async () => {
    giveRole(TEST_ADMIN_USER_ID, ['students']);
    const denied = await authenticatedRequest('post', '/api/jk/domains', mockAdminUser()).send({ documentType: 'report_card', name: 'X' });
    expect(denied.status).toBe(403);

    mockQueryResponse([{ domain_id: 'd1' }]);
    const ok = await authenticatedRequest('post', '/api/jk/domains', mockTeacherUser()).send({ documentType: 'report_card', name: 'X', school: 'PLAYGROUND' });
    expect(ok.status).toBe(200);
    expect(controllerCalls()[0][1][3]).toBe(TEST_SCHOOL);
  });

  it('reads the set-up of the caller\'s school, whatever ?school= says', async () => {
    mockQueryResponse([]);
    const res = await authenticatedRequest('get', '/api/sk/subjects?documentType=report_card&school=PLAYGROUND', mockTeacherUser());
    expect(res.status).toBe(200);
    expect(controllerCalls()[0][1]).toEqual(['report_card', TEST_SCHOOL]);
  });

  it('404s a new skill under another school\'s domain', async () => {
    mockQueryResponse([]); // INSERT ... SELECT matched no domain of this school
    const res = await authenticatedRequest('post', '/api/jk/skills', mockTeacherUser()).send({ domainId: 'd-elsewhere', name: 'S' });
    expect(res.status).toBe(404);
  });
});
