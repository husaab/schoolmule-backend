const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildTuitionPlanRow } = require('../../helpers/factories');

let app;
beforeAll(() => {
  app = getApp();
});

const authHeader = () => {
  const token = mockAdminUser();
  return { Authorization: `Bearer ${token}` };
};

// ─── GET /api/tuition-plans?school=X ────────────────────────────
describe('GET /api/tuition-plans', () => {
  const url = '/api/tuition-plans';

  it('returns tuition plans by school', async () => {
    const rows = [
      buildTuitionPlanRow({ grade: 3 }),
      buildTuitionPlanRow({ grade: 5, amount: 600 }),
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toHaveProperty('planId');
    expect(res.body.data[0]).toHaveProperty('grade');
    expect(res.body.data[0]).toHaveProperty('amount');
    expect(res.body.data[0]).toHaveProperty('frequency');
    expect(res.body.data[0]).toHaveProperty('effectiveFrom');
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('school');
  });

  it('returns empty array when no plans found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app)
      .get(url)
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(401);
  });
});

// ─── GET /api/tuition-plans/active?school=X ─────────────────────
describe('GET /api/tuition-plans/active', () => {
  const url = '/api/tuition-plans/active';

  it('returns active tuition plans', async () => {
    const rows = [buildTuitionPlanRow()];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(1);
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/tuition-plans/grade/:grade?school=X ───────────────
describe('GET /api/tuition-plans/grade/:grade', () => {
  it('returns tuition plans by grade and school', async () => {
    const rows = [buildTuitionPlanRow({ grade: 5 })];
    mockQueryResponse(rows);

    const res = await request(app)
      .get('/api/tuition-plans/grade/5')
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(1);
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .get('/api/tuition-plans/grade/5')
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get('/api/tuition-plans/grade/5')
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/tuition-plans/:planId ─────────────────────────────
describe('GET /api/tuition-plans/:planId', () => {
  it('returns a tuition plan by ID', async () => {
    const row = buildTuitionPlanRow();
    mockQueryResponse([row]);

    const res = await request(app)
      .get(`/api/tuition-plans/${row.plan_id}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('planId');
    expect(res.body.data).toHaveProperty('amount');
  });

  it('returns 404 when plan not found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .get('/api/tuition-plans/nonexistent-id')
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('not found');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get('/api/tuition-plans/some-id')
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── POST /api/tuition-plans ────────────────────────────────────
describe('POST /api/tuition-plans', () => {
  const url = '/api/tuition-plans';

  const validBody = {
    school: TEST_SCHOOL,
    grade: 5,
    amount: 500,
    frequency: 'monthly',
    effectiveFrom: '2025-09-01',
    effectiveTo: '2026-06-30',
  };

  it('creates a tuition plan successfully', async () => {
    const created = buildTuitionPlanRow(validBody);
    mockQueryResponse([created]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('planId');
    expect(res.body.data).toHaveProperty('amount');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({ school: TEST_SCHOOL, grade: 5 });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('Missing required fields');
  });

  it('creates plan without effectiveTo', async () => {
    const bodyNoEnd = { ...validBody, effectiveTo: undefined };
    const created = buildTuitionPlanRow({ ...bodyNoEnd, effective_to: null });
    mockQueryResponse([created]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send(bodyNoEnd);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send(validBody);

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── PATCH /api/tuition-plans/:planId ───────────────────────────
describe('PATCH /api/tuition-plans/:planId', () => {
  it('updates a tuition plan', async () => {
    const updated = buildTuitionPlanRow({ amount: 600 });
    mockQueryResponse([updated]);

    const res = await request(app)
      .patch(`/api/tuition-plans/${updated.plan_id}`)
      .set(authHeader())
      .send({ school: TEST_SCHOOL, amount: 600 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('planId');
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .patch('/api/tuition-plans/some-id')
      .set(authHeader())
      .send({ amount: 600 });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 404 when plan not found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .patch('/api/tuition-plans/nonexistent-id')
      .set(authHeader())
      .send({ school: TEST_SCHOOL, amount: 600 });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .patch('/api/tuition-plans/some-id')
      .set(authHeader())
      .send({ school: TEST_SCHOOL, amount: 600 });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── DELETE /api/tuition-plans/:planId ──────────────────────────
describe('DELETE /api/tuition-plans/:planId', () => {
  it('deletes a tuition plan', async () => {
    const row = buildTuitionPlanRow();
    mockQueryResponse([row]);

    const res = await request(app)
      .delete(`/api/tuition-plans/${row.plan_id}`)
      .set(authHeader())
      .send({ school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toContain('deleted');
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .delete('/api/tuition-plans/some-id')
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 404 when plan not found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .delete('/api/tuition-plans/nonexistent-id')
      .set(authHeader())
      .send({ school: TEST_SCHOOL });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .delete('/api/tuition-plans/some-id')
      .set(authHeader())
      .send({ school: TEST_SCHOOL });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});
