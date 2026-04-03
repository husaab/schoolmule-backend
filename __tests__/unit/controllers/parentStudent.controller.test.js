const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const {
  mockAdminUser,
  mockParentUser,
  TEST_PARENT_USER_ID,
  TEST_SCHOOL,
} = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildParentStudentRow } = require('../../helpers/factories');

let app;
beforeAll(() => {
  app = getApp();
});

const authHeader = () => {
  const token = mockAdminUser();
  return { Authorization: `Bearer ${token}` };
};

// ─── GET /api/parent-students?school=X ──────────────────────────
describe('GET /api/parent-students', () => {
  const url = '/api/parent-students';

  it('returns all parent-student relations by school', async () => {
    const rows = [
      {
        ...buildParentStudentRow(),
        student_name: 'John Smith',
        student_grade: 5,
        parent_first_name: 'Parent',
        parent_last_name: 'User',
        parent_user_email: 'parent@test.com',
      },
      {
        ...buildParentStudentRow({ student_id: 'student-2' }),
        student_name: 'Jane Doe',
        student_grade: 3,
        parent_first_name: 'Parent',
        parent_last_name: 'User',
        parent_user_email: 'parent@test.com',
      },
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toHaveProperty('parentStudentLinkId');
    expect(res.body.data[0]).toHaveProperty('studentId');
    expect(res.body.data[0]).toHaveProperty('student');
    expect(res.body.data[0].student).toHaveProperty('name');
    expect(res.body.data[0]).toHaveProperty('parentUser');
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('school');
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

// ─── GET /api/parent-students/:id ───────────────────────────────
describe('GET /api/parent-students/:id', () => {
  it('returns a parent-student relation by ID', async () => {
    const row = {
      ...buildParentStudentRow(),
      student_name: 'John Smith',
      student_grade: 5,
      parent_first_name: 'Parent',
      parent_last_name: 'User',
      parent_user_email: 'parent@test.com',
    };
    mockQueryResponse([row]);

    const res = await request(app)
      .get(`/api/parent-students/${row.parent_student_link_id}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('parentStudentLinkId');
    expect(res.body.data).toHaveProperty('student');
    expect(res.body.data).toHaveProperty('parentUser');
  });

  it('returns 404 when relation not found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .get('/api/parent-students/nonexistent-id')
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get('/api/parent-students/some-id')
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/parent-students/student/:studentId ────────────────
describe('GET /api/parent-students/student/:studentId', () => {
  it('returns parent relations for a student', async () => {
    const rows = [
      {
        ...buildParentStudentRow({ relation: 'MOTHER' }),
        parent_first_name: 'Mom',
        parent_last_name: 'User',
        parent_user_email: 'mom@test.com',
      },
      {
        ...buildParentStudentRow({ relation: 'FATHER' }),
        parent_first_name: 'Dad',
        parent_last_name: 'User',
        parent_user_email: 'dad@test.com',
      },
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get('/api/parent-students/student/student-123')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toHaveProperty('relation');
    expect(res.body.data[0]).toHaveProperty('parentUser');
  });

  it('returns empty array when no parents linked', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .get('/api/parent-students/student/orphan-student')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

// ─── GET /api/parent-students/parent/:parentId ──────────────────
describe('GET /api/parent-students/parent/:parentId', () => {
  it('returns student relations for a parent', async () => {
    const rows = [
      {
        ...buildParentStudentRow(),
        student_name: 'John Smith',
        student_grade: 5,
        student_oen: '123456789',
        homeroom_teacher_id: 'teacher-1',
        homeroom_teacher_first_name: 'Teacher',
        homeroom_teacher_last_name: 'Name',
      },
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(`/api/parent-students/parent/${TEST_PARENT_USER_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toHaveProperty('student');
    expect(res.body.data[0].student).toHaveProperty('name');
    expect(res.body.data[0].student).toHaveProperty('grade');
    expect(res.body.data[0].student).toHaveProperty('homeroomTeacher');
  });

  it('returns empty array when parent has no students', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .get('/api/parent-students/parent/no-children-parent')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

// ─── POST /api/parent-students ──────────────────────────────────
describe('POST /api/parent-students', () => {
  const url = '/api/parent-students';

  const validBody = {
    studentId: 'student-123',
    parentId: TEST_PARENT_USER_ID,
    parentName: 'Parent User',
    parentEmail: 'parent@test.com',
    parentNumber: '555-0300',
    relation: 'MOTHER',
    school: TEST_SCHOOL,
  };

  it('creates a parent-student relation', async () => {
    // checkExistingRelation returns no existing
    mockQueryResponse([]);
    // createParentStudent
    const created = buildParentStudentRow({
      student_id: validBody.studentId,
      parent_id: validBody.parentId,
    });
    mockQueryResponse([created]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('parentStudentLinkId');
    expect(res.body.data).toHaveProperty('studentId');
    expect(res.body.data).toHaveProperty('relation');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({ parentId: TEST_PARENT_USER_ID });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('required fields');
  });

  it('returns 409 when relation already exists', async () => {
    // checkExistingRelation returns existing
    mockQueryResponse([buildParentStudentRow()]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send(validBody);

    expect(res.status).toBe(409);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('already exists');
  });

  it('creates without parentId (no duplicate check)', async () => {
    const bodyNoParentId = { ...validBody, parentId: undefined };
    const created = buildParentStudentRow({
      student_id: bodyNoParentId.studentId,
      parent_id: null,
    });
    mockQueryResponse([created]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send(bodyNoParentId);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
  });

  it('returns 500 on database error', async () => {
    // checkExistingRelation succeeds
    mockQueryResponse([]);
    // createParentStudent fails
    mockQueryError('DB error');

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send(validBody);

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── PATCH /api/parent-students/:id ─────────────────────────────
describe('PATCH /api/parent-students/:id', () => {
  it('updates a parent-student relation', async () => {
    const updated = buildParentStudentRow({ relation: 'FATHER' });
    mockQueryResponse([updated], 1);

    const res = await request(app)
      .patch(`/api/parent-students/${updated.parent_student_link_id}`)
      .set(authHeader())
      .send({ relation: 'FATHER', parentName: 'Updated Parent' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('parentStudentLinkId');
  });

  it('returns 404 when relation not found', async () => {
    mockQueryResponse([], 0);

    const res = await request(app)
      .patch('/api/parent-students/nonexistent-id')
      .set(authHeader())
      .send({ relation: 'FATHER' });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .patch('/api/parent-students/some-id')
      .set(authHeader())
      .send({ relation: 'FATHER' });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── DELETE /api/parent-students/:id ────────────────────────────
describe('DELETE /api/parent-students/:id', () => {
  it('deletes a parent-student relation', async () => {
    mockQueryResponse([], 1);

    const res = await request(app)
      .delete('/api/parent-students/link-123')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toContain('deleted');
  });

  it('returns 404 when relation not found', async () => {
    mockQueryResponse([], 0);

    const res = await request(app)
      .delete('/api/parent-students/nonexistent-id')
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .delete('/api/parent-students/some-id')
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});
