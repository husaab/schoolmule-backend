const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, mockParentUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const db = require('../../__mocks__/config/database');
const engine = require('../../../services/analyticsEngine');

let app;
beforeAll(() => {
  app = getApp();
});

const CLASS = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';
const A1 = '33333333-3333-4333-8333-333333333333';
const A2 = '44444444-4444-4444-8444-444444444444';
const url = `/api/classes/${CLASS}/stats-exclusions`;
const auth = () => ({ Authorization: `Bearer ${mockAdminUser()}` });

// The class guard looks the class up first (requireClassOwnership).
const mockClass = () => mockQueryResponse([{ class_id: CLASS, school: TEST_SCHOOL, teacher_id: 'someone', is_co_teacher: false }]);

const exclusionRow = (overrides = {}) => ({
  class_id: CLASS,
  student_id: STUDENT,
  assessment_id: null,
  note: 'ESL newcomer',
  created_by: 'u1',
  created_by_name: 'Ms. Test',
  created_at: '2026-10-27T12:00:00.000Z',
  ...overrides,
});

// Transaction client: answers by SQL text and records every call.
function mockClient(answers) {
  const calls = [];
  db._mockClient.query.mockImplementation((sql, params) => {
    calls.push({ sql, params });
    const hit = Object.entries(answers).find(([needle]) => sql.includes(needle));
    return Promise.resolve(hit ? { rows: hit[1] } : { rows: [] });
  });
  return calls;
}

describe('GET /api/classes/:classId/stats-exclusions', () => {
  it('groups rows into one entry per student', async () => {
    mockClass();
    mockQueryResponse([
      exclusionRow(),
      exclusionRow({ student_id: 's2', assessment_id: A1, note: null }),
      exclusionRow({ student_id: 's2', assessment_id: A2, note: null }),
    ]);

    const res = await request(app).get(url).set(auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ studentId: STUDENT, scope: 'class', assessmentIds: [], note: 'ESL newcomer', createdByName: 'Ms. Test' }),
      expect.objectContaining({ studentId: 's2', scope: 'assessments', assessmentIds: [A1, A2], note: null }),
    ]);
  });

  it('refuses parents', async () => {
    const res = await request(app).get(url).set({ Authorization: `Bearer ${mockParentUser()}` });
    expect(res.status).toBe(403);
  });

  it('returns 500 on database error', async () => {
    mockClass();
    mockQueryError('boom');
    const res = await request(app).get(url).set(auth());
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/classes/:classId/stats-exclusions/:studentId', () => {
  const putUrl = `${url}/${STUDENT}`;

  it('leaves a student out of the whole class and clears the analytics cache', async () => {
    const spy = jest.spyOn(engine, 'invalidateCache');
    mockClass();
    const calls = mockClient({
      'FROM class_students': [{ '?column?': 1 }],
      'WHERE e.class_id = $1 AND e.student_id = $2': [exclusionRow({ note: 'Newcomer' })],
    });

    const res = await request(app).put(putUrl).set(auth()).send({ scope: 'class', note: '  Newcomer  ' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ studentId: STUDENT, scope: 'class', note: 'Newcomer' });
    const insert = calls.find((c) => c.sql.includes('VALUES ($1, $2, NULL'));
    expect(insert.params).toEqual([CLASS, STUDENT, 'Newcomer', expect.any(String)]);
    expect(calls.findIndex((c) => c.sql.includes('DELETE FROM class_stats_exclusions')))
      .toBeLessThan(calls.indexOf(insert));
    expect(calls.map((c) => c.sql)).toContain('COMMIT');
    expect(spy).toHaveBeenCalledWith(TEST_SCHOOL);
    spy.mockRestore();
  });

  it('leaves a student out of chosen assessments, once each', async () => {
    mockClass();
    const calls = mockClient({
      'FROM class_students': [{ '?column?': 1 }],
      'FROM assessments': [{ assessment_id: A1 }, { assessment_id: A2 }],
      'WHERE e.class_id = $1 AND e.student_id = $2': [
        exclusionRow({ assessment_id: A1, note: null }),
        exclusionRow({ assessment_id: A2, note: null }),
      ],
    });

    const res = await request(app).put(putUrl).set(auth()).send({ scope: 'assessments', assessmentIds: [A1, A2, A1] });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ scope: 'assessments', assessmentIds: [A1, A2] });
    const insert = calls.find((c) => c.sql.includes('unnest($3::uuid[])'));
    expect(insert.params[2]).toEqual([A1, A2]);
  });

  it("refuses an assessment from another class", async () => {
    mockClass();
    const calls = mockClient({
      'FROM class_students': [{ '?column?': 1 }],
      'FROM assessments': [{ assessment_id: A1 }],
    });

    const res = await request(app).put(putUrl).set(auth()).send({ scope: 'assessments', assessmentIds: [A1, A2] });

    expect(res.status).toBe(400);
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK');
    expect(calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });

  it("404s for a student who isn't in the class", async () => {
    mockClass();
    mockClient({ 'FROM class_students': [] });
    const res = await request(app).put(putUrl).set(auth()).send({ scope: 'class' });
    expect(res.status).toBe(404);
  });

  it.each([
    [{ scope: 'everything' }, /scope/],
    [{ scope: 'assessments' }, /at least one assessment/],
    [{ scope: 'assessments', assessmentIds: ['nope'] }, /assessment ids/],
    [{ scope: 'class', note: 'x'.repeat(501) }, /under 500/],
  ])('400s for %j', async (body, message) => {
    mockClass();
    const res = await request(app).put(putUrl).set(auth()).send(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
  });

  it('rolls back and 500s when the save fails', async () => {
    mockClass();
    const calls = [];
    db._mockClient.query.mockImplementation((sql) => {
      calls.push(sql);
      if (sql.includes('FROM class_students')) return Promise.resolve({ rows: [{}] });
      if (sql.includes('INSERT')) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).put(putUrl).set(auth()).send({ scope: 'class' });

    expect(res.status).toBe(500);
    expect(calls).toContain('ROLLBACK');
    expect(db._mockClient.release).toHaveBeenCalled();
  });
});

describe('DELETE /api/classes/:classId/stats-exclusions/:studentId', () => {
  it('counts the student again', async () => {
    mockClass();
    mockQueryResponse([], 1);
    const res = await request(app).delete(`${url}/${STUDENT}`).set(auth());
    expect(res.status).toBe(200);
    expect(db.query.mock.calls.some(([sql, params]) =>
      sql.includes('DELETE FROM class_stats_exclusions') && params[0] === CLASS && params[1] === STUDENT)).toBe(true);
  });

  it('400s for a malformed student id', async () => {
    mockClass();
    const res = await request(app).delete(`${url}/not-a-uuid`).set(auth());
    expect(res.status).toBe(400);
  });
});

describe('GET /api/analytics/stats-exclusions', () => {
  const listUrl = '/api/analytics/stats-exclusions';
  const TERM = '55555555-5555-4555-8555-555555555555';

  it("lists the school's exclusions with class, student and assessment names", async () => {
    mockQueryResponse([
      exclusionRow({ student_name: 'Student One', subject: 'Math', grade: '6', term_id: TERM, teacher_name: 'Ms. Test', assessment_name: null }),
      exclusionRow({ class_id: 'c2', student_name: 'Student One', subject: 'Science', grade: '6', term_id: TERM, teacher_name: null, assessment_id: A1, assessment_name: 'Lab 1' }),
    ]);

    const res = await request(app).get(listUrl).set(auth()).query({ termId: TERM });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ classId: CLASS, subject: 'Math', scope: 'class', assessmentNames: [], studentName: 'Student One' }),
      expect.objectContaining({ classId: 'c2', subject: 'Science', scope: 'assessments', assessmentNames: ['Lab 1'] }),
    ]);
    const [, params] = db.query.mock.calls.find(([sql]) => sql.includes('FROM class_stats_exclusions'));
    expect(params).toEqual([TEST_SCHOOL, TERM]);
  });

  it("reads every term for 'all'", async () => {
    mockQueryResponse([]);
    await request(app).get(listUrl).set(auth()).query({ termId: 'all' });
    const [, params] = db.query.mock.calls.find(([sql]) => sql.includes('FROM class_stats_exclusions'));
    expect(params).toEqual([TEST_SCHOOL, null]);
  });

  it('400s without a termId', async () => {
    const res = await request(app).get(listUrl).set(auth());
    expect(res.status).toBe(400);
  });
});
