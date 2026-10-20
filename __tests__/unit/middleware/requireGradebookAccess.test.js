const requireGradebookAccess = require('../../../middleware/requireGradebookAccess');
const db = require('../../__mocks__/config/database');
const { mockQueryResponse } = require('../../helpers/mockDb');
const { giveRole } = require('../../helpers/mockAccess');

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const row = (fields = {}) => ({
  class_id: 'c1', school: 'ALHAADIACADEMY', teacher_id: 'lead', is_co_teacher: false,
  classes_found: 0, assessments_found: 1, ...fields,
});
const reqFor = (userId, role = 'TEACHER', body = {}) => ({ user: { userId, role, school: 'ALHAADIACADEMY' }, params: { id: 'a1' }, body });
const run = async (mw, req) => {
  const res = makeRes();
  const next = jest.fn();
  await mw(req, res, next);
  return { res, next };
};

const byAssessment = requireGradebookAccess({ assessmentIds: (req) => [req.params.id] });

describe('requireGradebookAccess', () => {
  it("lets the class's teacher in and sets req.class", async () => {
    mockQueryResponse([row()]);
    const req = reqFor('lead');
    const { next } = await run(byAssessment, req);
    expect(next).toHaveBeenCalled();
    expect(req.class).toEqual({ classId: 'c1', school: 'ALHAADIACADEMY', teacherId: 'lead' });
  });

  it('keeps another teacher out', async () => {
    mockQueryResponse([row()]);
    expect((await run(byAssessment, reqFor('other'))).res.statusCode).toBe(403);
  });

  it('keeps office staff without classes.all out', async () => {
    giveRole('office', ['students', 'report_cards', 'attendance.classes']);
    mockQueryResponse([row()]);
    expect((await run(byAssessment, reqFor('office', 'ADMIN'))).res.statusCode).toBe(403);
  });

  it('404s when any named id is unknown', async () => {
    mockQueryResponse([]);
    expect((await run(byAssessment, reqFor('lead'))).res.statusCode).toBe(404);

    const both = requireGradebookAccess({ assessmentIds: () => ['a1', 'a2'], classIds: () => ['c1'] });
    mockQueryResponse([row({ classes_found: 1, assessments_found: 1 })]);
    expect((await run(both, reqFor('lead'))).res.statusCode).toBe(404);
  });

  it('refuses when one of several classes is not theirs', async () => {
    const batch = requireGradebookAccess({ assessmentIds: () => ['a1', 'a2'] });
    mockQueryResponse([row({ assessments_found: 2 }), row({ class_id: 'c2', teacher_id: 'other', assessments_found: 2 })]);
    expect((await run(batch, reqFor('lead'))).res.statusCode).toBe(403);
  });

  it('never trusts a class in another school', async () => {
    mockQueryResponse([row({ school: 'PLAYGROUND' })]);
    expect((await run(byAssessment, reqFor('lead'))).res.statusCode).toBe(403);
  });

  it('passes through with no ids so the controller can answer 400', async () => {
    const none = requireGradebookAccess({ classIds: () => [undefined] });
    const { next } = await run(none, reqFor('lead'));
    expect(next).toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('answers 403, not 500, on a malformed id', async () => {
    db.query.mockRejectedValueOnce(new Error('invalid input syntax for type uuid'));
    expect((await run(byAssessment, reqFor('lead'))).res.statusCode).toBe(403);
  });
});
