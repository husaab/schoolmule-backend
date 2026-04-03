const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_ADMIN_USER_ID, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildTuitionInvoiceCommentRow } = require('../../helpers/factories');

let app;
beforeAll(() => {
  app = getApp();
});

const authHeader = () => {
  const token = mockAdminUser();
  return { Authorization: `Bearer ${token}` };
};

// ─── GET /api/tuition-invoice-comments/invoice/:invoiceId ───────
describe('GET /api/tuition-invoice-comments/invoice/:invoiceId', () => {
  it('returns comments for an invoice', async () => {
    const rows = [
      buildTuitionInvoiceCommentRow({ invoice_id: 'inv-1' }),
      buildTuitionInvoiceCommentRow({ invoice_id: 'inv-1', comment: 'Follow-up note' }),
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get('/api/tuition-invoice-comments/invoice/inv-1')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toHaveProperty('commentId');
    expect(res.body.data[0]).toHaveProperty('invoiceId');
    expect(res.body.data[0]).toHaveProperty('commenterName');
    expect(res.body.data[0]).toHaveProperty('comment');
    expect(res.body.data[0]).toHaveProperty('createdAt');
  });

  it('returns empty array when no comments found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .get('/api/tuition-invoice-comments/invoice/inv-empty')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get('/api/tuition-invoice-comments/invoice/inv-1')
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('Error fetching invoice comments');
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app)
      .get('/api/tuition-invoice-comments/invoice/inv-1');

    expect(res.status).toBe(401);
  });
});

// ─── GET /api/tuition-invoice-comments/:commentId ───────────────
describe('GET /api/tuition-invoice-comments/:commentId', () => {
  it('returns a comment by ID', async () => {
    const row = buildTuitionInvoiceCommentRow();
    mockQueryResponse([row]);

    const res = await request(app)
      .get(`/api/tuition-invoice-comments/${row.comment_id}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('commentId');
    expect(res.body.data).toHaveProperty('comment');
  });

  it('returns 404 when comment not found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .get('/api/tuition-invoice-comments/nonexistent-id')
      .set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('not found');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get('/api/tuition-invoice-comments/some-id')
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/tuition-invoice-comments/commenter/:commenterId ───
describe('GET /api/tuition-invoice-comments/commenter/:commenterId', () => {
  it('returns comments by commenter ID', async () => {
    const rows = [
      buildTuitionInvoiceCommentRow({ commenter_id: TEST_ADMIN_USER_ID }),
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(`/api/tuition-invoice-comments/commenter/${TEST_ADMIN_USER_ID}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(1);
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get(`/api/tuition-invoice-comments/commenter/${TEST_ADMIN_USER_ID}`)
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/tuition-invoice-comments/school?school=X ──────────
describe('GET /api/tuition-invoice-comments/school', () => {
  const url = '/api/tuition-invoice-comments/school';

  it('returns comments by school', async () => {
    const rows = [
      buildTuitionInvoiceCommentRow(),
      buildTuitionInvoiceCommentRow({ comment: 'Another comment' }),
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(2);
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
});

// ─── GET /api/tuition-invoice-comments/recent?school=X ──────────
describe('GET /api/tuition-invoice-comments/recent', () => {
  const url = '/api/tuition-invoice-comments/recent';

  it('returns recent comments with default limit', async () => {
    const rows = [
      {
        ...buildTuitionInvoiceCommentRow(),
        student_name: 'John Smith',
        amount_due: 500,
      },
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toHaveProperty('studentName');
    expect(res.body.data[0]).toHaveProperty('amountDue');
  });

  it('accepts a custom limit parameter', async () => {
    const rows = [buildTuitionInvoiceCommentRow()];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ school: TEST_SCHOOL, limit: 5 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
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
});

// ─── POST /api/tuition-invoice-comments ─────────────────────────
describe('POST /api/tuition-invoice-comments', () => {
  const url = '/api/tuition-invoice-comments';

  const validBody = {
    invoiceId: 'inv-123',
    commenterId: TEST_ADMIN_USER_ID,
    commenterName: 'Admin User',
    comment: 'Payment received via e-transfer.',
  };

  it('creates a comment successfully', async () => {
    const created = buildTuitionInvoiceCommentRow({
      invoice_id: validBody.invoiceId,
      commenter_id: validBody.commenterId,
      comment: validBody.comment,
    });
    mockQueryResponse([created]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('commentId');
    expect(res.body.data).toHaveProperty('comment');
    expect(res.body.data.comment).toBe(validBody.comment);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({ invoiceId: 'inv-123' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('Missing required fields');
  });

  it('returns 400 when comment text is missing', async () => {
    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        invoiceId: 'inv-123',
        commenterId: TEST_ADMIN_USER_ID,
        commenterName: 'Admin',
      });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
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

// ─── PATCH /api/tuition-invoice-comments/:commentId ─────────────
describe('PATCH /api/tuition-invoice-comments/:commentId', () => {
  it('updates a comment', async () => {
    const updated = buildTuitionInvoiceCommentRow({ comment: 'Updated comment text' });
    mockQueryResponse([updated]);

    const res = await request(app)
      .patch(`/api/tuition-invoice-comments/${updated.comment_id}`)
      .set(authHeader())
      .send({ comment: 'Updated comment text', commenterId: TEST_ADMIN_USER_ID });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('commentId');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .patch('/api/tuition-invoice-comments/some-id')
      .set(authHeader())
      .send({ comment: 'Updated' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 404 when comment not found or unauthorized', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .patch('/api/tuition-invoice-comments/nonexistent')
      .set(authHeader())
      .send({ comment: 'Updated', commenterId: TEST_ADMIN_USER_ID });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('not found');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .patch('/api/tuition-invoice-comments/some-id')
      .set(authHeader())
      .send({ comment: 'Updated', commenterId: TEST_ADMIN_USER_ID });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── DELETE /api/tuition-invoice-comments/:commentId ────────────
describe('DELETE /api/tuition-invoice-comments/:commentId', () => {
  it('deletes a comment', async () => {
    const row = buildTuitionInvoiceCommentRow();
    mockQueryResponse([row]);

    const res = await request(app)
      .delete(`/api/tuition-invoice-comments/${row.comment_id}`)
      .set(authHeader())
      .send({ commenterId: TEST_ADMIN_USER_ID });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toContain('deleted');
  });

  it('returns 400 when commenterId is missing', async () => {
    const res = await request(app)
      .delete('/api/tuition-invoice-comments/some-id')
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 404 when comment not found or unauthorized', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .delete('/api/tuition-invoice-comments/nonexistent')
      .set(authHeader())
      .send({ commenterId: TEST_ADMIN_USER_ID });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .delete('/api/tuition-invoice-comments/some-id')
      .set(authHeader())
      .send({ commenterId: TEST_ADMIN_USER_ID });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});
