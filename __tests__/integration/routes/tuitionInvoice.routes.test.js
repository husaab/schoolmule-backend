jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('Integration: Tuition Invoice Routes', () => {
  let app, pool;

  beforeAll(() => {
    app = getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
      [TEST_USER_ID, 'admin@test.com', 'Admin User', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN']
    );
  });

  // Seed a student and return its ID
  const seedStudent = async () => {
    const { rows } = await pool.query(
      `INSERT INTO students (name, school, grade) VALUES ('Alice Smith', 'ALHAADIACADEMY', '5') RETURNING student_id`
    );
    return rows[0].student_id;
  };

  // Seed a tuition plan and return its ID
  const seedTuitionPlan = async () => {
    const { rows } = await pool.query(
      `INSERT INTO tuition_plans (school, grade, amount, frequency)
       VALUES ('ALHAADIACADEMY', '5', 500.00, 'Monthly') RETURNING plan_id`
    );
    return rows[0].plan_id;
  };

  // Seed an invoice and return the full row
  const seedInvoice = async (overrides = {}) => {
    const studentId = overrides.studentId || await seedStudent();
    const planId = overrides.planId || await seedTuitionPlan();
    const defaults = {
      studentName: 'Alice Smith',
      studentGrade: '5',
      periodStart: '2025-10-01',
      periodEnd: '2025-10-31',
      amountDue: 500.00,
      dateDue: '2025-10-15',
      status: 'pending',
      school: 'ALHAADIACADEMY',
    };
    const data = { ...defaults, ...overrides };
    const { rows } = await pool.query(
      `INSERT INTO tuition_invoices (plan_id, student_id, student_name, student_grade, period_start, period_end, amount_due, date_due, status, school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [planId, studentId, data.studentName, data.studentGrade, data.periodStart, data.periodEnd, data.amountDue, data.dateDue, data.status, data.school]
    );
    return rows[0];
  };

  describe('POST /api/tuition-invoices', () => {
    it('creates a tuition invoice', async () => {
      const studentId = await seedStudent();
      const planId = await seedTuitionPlan();

      const res = await authenticatedRequest('post', '/api/tuition-invoices')
        .send({
          planId,
          studentId,
          studentName: 'Alice Smith',
          studentGrade: '5',
          periodStart: '2025-10-01',
          periodEnd: '2025-10-31',
          amountDue: 500.00,
          dateDue: '2025-10-15',
          school: 'ALHAADIACADEMY',
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.studentName).toBe('Alice Smith');
      expect(parseFloat(res.body.data.amountDue)).toBe(500.00);
      expect(res.body.data.status).toBe('pending');

      const dbResult = await pool.query('SELECT * FROM tuition_invoices WHERE student_id = $1', [studentId]);
      expect(dbResult.rows).toHaveLength(1);
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await authenticatedRequest('post', '/api/tuition-invoices')
        .send({ studentName: 'Alice' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });
  });

  describe('GET /api/tuition-invoices?school=', () => {
    it('returns all invoices for a school', async () => {
      await seedInvoice();
      await seedInvoice({ studentName: 'Bob Jones', periodStart: '2025-11-01', periodEnd: '2025-11-30', dateDue: '2025-11-15' });

      const res = await authenticatedRequest('get', '/api/tuition-invoices?school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    });

    it('returns 400 when school is missing', async () => {
      const res = await authenticatedRequest('get', '/api/tuition-invoices');

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/tuition-invoices/:invoiceId', () => {
    it('returns an invoice by ID', async () => {
      const invoice = await seedInvoice();

      const res = await authenticatedRequest('get', `/api/tuition-invoices/${invoice.invoice_id}`);

      expect(res.status).toBe(200);
      expect(res.body.data.invoiceId).toBe(invoice.invoice_id);
    });

    it('returns 404 for non-existent invoice', async () => {
      const res = await authenticatedRequest('get', '/api/tuition-invoices/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/tuition-invoices/student/:studentId', () => {
    it('returns invoices for a student', async () => {
      const studentId = await seedStudent();
      const planId = await seedTuitionPlan();
      await seedInvoice({ studentId, planId });

      const res = await authenticatedRequest('get', `/api/tuition-invoices/student/${studentId}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('PATCH /api/tuition-invoices/:invoiceId', () => {
    it('updates an invoice', async () => {
      const invoice = await seedInvoice();

      const res = await authenticatedRequest('patch', `/api/tuition-invoices/${invoice.invoice_id}`)
        .send({
          studentName: 'Alice Smith Updated',
          amountDue: 550.00,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.studentName).toBe('Alice Smith Updated');
    });

    it('returns 404 for non-existent invoice', async () => {
      const res = await authenticatedRequest('patch', '/api/tuition-invoices/00000000-0000-0000-0000-000000000000')
        .send({ studentName: 'Test' });

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/tuition-invoices/:invoiceId/payment', () => {
    it('updates invoice payment', async () => {
      const invoice = await seedInvoice();

      const res = await authenticatedRequest('patch', `/api/tuition-invoices/${invoice.invoice_id}/payment`)
        .send({
          amountPaid: 500.00,
          datePaid: '2025-10-10',
          status: 'paid',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('paid');
      expect(parseFloat(res.body.data.amountPaid)).toBe(500.00);

      const dbResult = await pool.query('SELECT status FROM tuition_invoices WHERE invoice_id = $1', [invoice.invoice_id]);
      expect(dbResult.rows[0].status).toBe('paid');
    });

    it('returns 400 when required payment fields are missing', async () => {
      const invoice = await seedInvoice();

      const res = await authenticatedRequest('patch', `/api/tuition-invoices/${invoice.invoice_id}/payment`)
        .send({ amountPaid: 500.00 });

      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent invoice', async () => {
      const res = await authenticatedRequest('patch', '/api/tuition-invoices/00000000-0000-0000-0000-000000000000/payment')
        .send({ amountPaid: 500.00, datePaid: '2025-10-10', status: 'paid' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/tuition-invoices/:invoiceId', () => {
    it('deletes an invoice', async () => {
      const invoice = await seedInvoice();

      const res = await authenticatedRequest('delete', `/api/tuition-invoices/${invoice.invoice_id}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const dbResult = await pool.query('SELECT * FROM tuition_invoices WHERE invoice_id = $1', [invoice.invoice_id]);
      expect(dbResult.rows).toHaveLength(0);
    });

    it('returns 404 for non-existent invoice', async () => {
      const res = await authenticatedRequest('delete', '/api/tuition-invoices/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/tuition-invoices/status/:status?school=', () => {
    it('returns invoices by status and school', async () => {
      await seedInvoice({ status: 'pending' });
      await seedInvoice({ status: 'paid', periodStart: '2025-11-01', periodEnd: '2025-11-30', dateDue: '2025-11-15' });

      const res = await authenticatedRequest('get', '/api/tuition-invoices/status/pending?school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      const pendingInvoices = res.body.data.filter(i => i.status === 'pending');
      expect(pendingInvoices.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 400 when school is missing', async () => {
      const res = await authenticatedRequest('get', '/api/tuition-invoices/status/pending');

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/tuition-invoices/overdue?school=', () => {
    it('returns overdue invoices', async () => {
      // Insert an invoice with a past due date
      await seedInvoice({ dateDue: '2020-01-01', status: 'pending' });

      const res = await authenticatedRequest('get', '/api/tuition-invoices/overdue?school=ALHAADIACADEMY');

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 400 when school is missing', async () => {
      const res = await authenticatedRequest('get', '/api/tuition-invoices/overdue');

      expect(res.status).toBe(400);
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/tuition-invoices?school=ALHAADIACADEMY');

      expect(res.status).toBe(401);
    });
  });
});
