const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL, TEST_PARENT_USER_ID } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildTuitionInvoiceRow, buildTuitionPlanRow, buildStudentRow } = require('../../helpers/factories');

let app;
beforeAll(() => {
  app = getApp();
});

const authHeader = () => {
  const token = mockAdminUser();
  return { Authorization: `Bearer ${token}` };
};

// ─── GET /api/tuition-invoices?school=X ─────────────────────────
describe('GET /api/tuition-invoices', () => {
  const url = '/api/tuition-invoices';

  it('returns tuition invoices by school', async () => {
    const rows = [
      buildTuitionInvoiceRow(),
      buildTuitionInvoiceRow({ status: 'paid', amount_paid: 500 }),
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toHaveProperty('invoiceId');
    expect(res.body.data[0]).toHaveProperty('studentName');
    expect(res.body.data[0]).toHaveProperty('amountDue');
    expect(res.body.data[0]).toHaveProperty('status');
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
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

// ─── GET /api/tuition-invoices/overdue?school=X ─────────────────
describe('GET /api/tuition-invoices/overdue', () => {
  const url = '/api/tuition-invoices/overdue';

  it('returns overdue invoices', async () => {
    const rows = [buildTuitionInvoiceRow({ status: 'overdue' })];
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
  });
});

// ─── GET /api/tuition-invoices/student/:studentId ───────────────
describe('GET /api/tuition-invoices/student/:studentId', () => {
  it('returns invoices for a student', async () => {
    const rows = [buildTuitionInvoiceRow({ student_id: 'student-1' })];
    mockQueryResponse(rows);

    const res = await request(app)
      .get('/api/tuition-invoices/student/student-1')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(1);
  });

  it('returns empty array when no invoices found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .get('/api/tuition-invoices/student/no-invoices-student')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get('/api/tuition-invoices/student/student-1')
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/tuition-invoices/parent/:parentId ─────────────────
describe('GET /api/tuition-invoices/parent/:parentId', () => {
  it('returns invoices for a parent', async () => {
    const rows = [
      buildTuitionInvoiceRow({ parent_id: TEST_PARENT_USER_ID }),
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(`/api/tuition-invoices/parent/${TEST_PARENT_USER_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(1);
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get(`/api/tuition-invoices/parent/${TEST_PARENT_USER_ID}`)
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/tuition-invoices/status/:status?school=X ──────────
describe('GET /api/tuition-invoices/status/:status', () => {
  it('returns invoices by status and school', async () => {
    const rows = [buildTuitionInvoiceRow({ status: 'pending' })];
    mockQueryResponse(rows);

    const res = await request(app)
      .get('/api/tuition-invoices/status/pending')
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(1);
  });

  it('returns 400 when school is missing', async () => {
    const res = await request(app)
      .get('/api/tuition-invoices/status/pending')
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/tuition-invoices/:invoiceId ───────────────────────
describe('GET /api/tuition-invoices/:invoiceId', () => {
  it('returns an invoice by ID', async () => {
    const row = buildTuitionInvoiceRow();
    mockQueryResponse([row]);

    const res = await request(app)
      .get(`/api/tuition-invoices/${row.invoice_id}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('invoiceId');
    expect(res.body.data).toHaveProperty('amountDue');
  });

  it('returns 404 when invoice not found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .get('/api/tuition-invoices/nonexistent-id')
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('not found');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get('/api/tuition-invoices/some-id')
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── POST /api/tuition-invoices ─────────────────────────────────
describe('POST /api/tuition-invoices', () => {
  const url = '/api/tuition-invoices';

  const validBody = {
    planId: 'plan-123',
    studentId: 'student-123',
    studentName: 'John Smith',
    studentGrade: 5,
    parentId: TEST_PARENT_USER_ID,
    parentName: 'Parent User',
    parentEmail: 'parent@test.com',
    parentNumber: '555-0300',
    periodStart: '2025-10-01',
    periodEnd: '2025-10-31',
    amountDue: 500,
    dateDue: '2025-10-15',
    status: 'pending',
    school: TEST_SCHOOL,
  };

  it('creates an invoice successfully', async () => {
    const created = buildTuitionInvoiceRow();
    mockQueryResponse([created]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('invoiceId');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({ planId: 'plan-123', school: TEST_SCHOOL });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('Missing required fields');
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

// ─── PATCH /api/tuition-invoices/:invoiceId ─────────────────────
describe('PATCH /api/tuition-invoices/:invoiceId', () => {
  it('updates an invoice', async () => {
    const updated = buildTuitionInvoiceRow({ status: 'paid' });
    mockQueryResponse([updated]);

    const res = await request(app)
      .patch(`/api/tuition-invoices/${updated.invoice_id}`)
      .set(authHeader())
      .send({ status: 'paid', amountPaid: 500 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('invoiceId');
  });

  it('returns 404 when invoice not found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .patch('/api/tuition-invoices/nonexistent-id')
      .set(authHeader())
      .send({ status: 'paid' });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .patch('/api/tuition-invoices/some-id')
      .set(authHeader())
      .send({ status: 'paid' });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── PATCH /api/tuition-invoices/:invoiceId/payment ─────────────
describe('PATCH /api/tuition-invoices/:invoiceId/payment', () => {
  it('updates invoice payment', async () => {
    const updated = buildTuitionInvoiceRow({
      amount_paid: 500,
      date_paid: '2025-10-20',
      status: 'paid',
    });
    mockQueryResponse([updated]);

    const res = await request(app)
      .patch('/api/tuition-invoices/inv-123/payment')
      .set(authHeader())
      .send({ amountPaid: 500, datePaid: '2025-10-20', status: 'paid' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('amountPaid');
  });

  it('returns 400 when required payment fields are missing', async () => {
    const res = await request(app)
      .patch('/api/tuition-invoices/inv-123/payment')
      .set(authHeader())
      .send({ amountPaid: 500 });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('Missing required fields');
  });

  it('returns 404 when invoice not found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .patch('/api/tuition-invoices/nonexistent/payment')
      .set(authHeader())
      .send({ amountPaid: 500, datePaid: '2025-10-20', status: 'paid' });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .patch('/api/tuition-invoices/inv-123/payment')
      .set(authHeader())
      .send({ amountPaid: 500, datePaid: '2025-10-20', status: 'paid' });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── DELETE /api/tuition-invoices/:invoiceId ────────────────────
describe('DELETE /api/tuition-invoices/:invoiceId', () => {
  it('deletes an invoice', async () => {
    const row = buildTuitionInvoiceRow();
    mockQueryResponse([row]);

    const res = await request(app)
      .delete(`/api/tuition-invoices/${row.invoice_id}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toContain('deleted');
  });

  it('returns 404 when invoice not found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .delete('/api/tuition-invoices/nonexistent-id')
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .delete('/api/tuition-invoices/some-id')
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── POST /api/tuition-invoices/generate ────────────────────────
describe('POST /api/tuition-invoices/generate', () => {
  const url = '/api/tuition-invoices/generate';

  it('generates invoices for students', async () => {
    const plans = [
      { ...buildTuitionPlanRow({ grade: 5, frequency: 'Monthly' }), plan_id: 'plan-1', amount: 500 },
    ];
    const students = [
      {
        student_id: 's1', student_name: 'John', grade: 5,
        mother_name: 'Jane', mother_email: 'jane@test.com', mother_number: '555-0100',
        father_name: null, father_email: null, father_number: null,
      },
    ];
    // selectActiveTuitionPlansBySchoolAndGrade
    mockQueryResponse(plans);
    // selectStudentsBySchoolAndGrade
    mockQueryResponse(students);
    // checkInvoiceExists (no existing invoice)
    mockQueryResponse([]);
    // insertTuitionInvoice
    mockQueryResponse([buildTuitionInvoiceRow()]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        school: TEST_SCHOOL,
        grade: 5,
        billingMonth: '2025-10',
        dueDate: '2025-10-15',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('invoicesCreated');
    expect(res.body.data.invoicesCreated).toBe(1);
  });

  it('skips existing invoices', async () => {
    const plans = [
      { ...buildTuitionPlanRow({ grade: 5, frequency: 'Monthly' }), plan_id: 'plan-1', amount: 500 },
    ];
    const students = [
      {
        student_id: 's1', student_name: 'John', grade: 5,
        mother_name: 'Jane', mother_email: 'jane@test.com', mother_number: '555-0100',
        father_name: null, father_email: null, father_number: null,
      },
    ];
    // selectActiveTuitionPlansBySchoolAndGrade
    mockQueryResponse(plans);
    // selectStudentsBySchoolAndGrade
    mockQueryResponse(students);
    // checkInvoiceExists (existing invoice found)
    mockQueryResponse([buildTuitionInvoiceRow()]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        school: TEST_SCHOOL,
        grade: 5,
        billingMonth: '2025-10',
        dueDate: '2025-10-15',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.invoicesCreated).toBe(0);
    expect(res.body.data.invoicesSkipped).toBe(1);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({ school: TEST_SCHOOL });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 404 when no plans found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        school: TEST_SCHOOL,
        grade: 5,
        billingMonth: '2025-10',
        dueDate: '2025-10-15',
      });

    expect(res.status).toBe(404);
    expect(res.body.message).toContain('No active tuition plans');
  });

  it('returns 404 when no students found', async () => {
    const plans = [
      { ...buildTuitionPlanRow({ grade: 5 }), plan_id: 'plan-1' },
    ];
    mockQueryResponse(plans);
    mockQueryResponse([]); // no students

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        school: TEST_SCHOOL,
        grade: 5,
        billingMonth: '2025-10',
        dueDate: '2025-10-15',
      });

    expect(res.status).toBe(404);
    expect(res.body.message).toContain('No students found');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        school: TEST_SCHOOL,
        grade: 5,
        billingMonth: '2025-10',
        dueDate: '2025-10-15',
      });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});
