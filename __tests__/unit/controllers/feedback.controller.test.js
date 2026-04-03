jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const {
  mockAdminUser,
  mockTeacherUser,
  TEST_TEACHER_USER_ID,
  TEST_PARENT_USER_ID,
  TEST_SCHOOL,
} = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildFeedbackRow } = require('../../helpers/factories');

let app;
beforeAll(() => {
  app = getApp();
});

const authHeader = () => {
  const token = mockTeacherUser();
  return { Authorization: `Bearer ${token}` };
};

// ─── GET /api/feedback/sent ─────────────────────────────────────
describe('GET /api/feedback/sent', () => {
  const url = '/api/feedback/sent';

  it('returns sent feedback for a sender', async () => {
    const rows = [
      buildFeedbackRow({ sender_id: TEST_TEACHER_USER_ID }),
      buildFeedbackRow({ sender_id: TEST_TEACHER_USER_ID, subject: 'Second' }),
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ senderId: TEST_TEACHER_USER_ID });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toHaveProperty('feedbackId');
    expect(res.body.data[0]).toHaveProperty('senderName');
    expect(res.body.data[0]).toHaveProperty('assessmentName');
  });

  it('returns 400 when senderId is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('senderId');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ senderId: TEST_TEACHER_USER_ID });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/feedback/inbox ────────────────────────────────────
describe('GET /api/feedback/inbox', () => {
  const url = '/api/feedback/inbox';

  it('returns inbox feedback for a recipient', async () => {
    const rows = [buildFeedbackRow({ recipient_id: TEST_PARENT_USER_ID })];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ recipientId: TEST_PARENT_USER_ID });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toHaveProperty('recipientName');
  });

  it('returns 400 when recipientId is missing', async () => {
    const res = await request(app)
      .get(url)
      .set(authHeader());

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('recipientId');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ recipientId: TEST_PARENT_USER_ID });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/feedback/student/:studentId ───────────────────────
describe('GET /api/feedback/student/:studentId', () => {
  it('returns feedback for a student', async () => {
    const studentId = 'student-uuid-1';
    const rows = [
      buildFeedbackRow({ student_id: studentId }),
      buildFeedbackRow({ student_id: studentId, assessment_name: 'Final' }),
    ];
    mockQueryResponse(rows);

    const res = await request(app)
      .get(`/api/feedback/student/${studentId}`)
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toHaveProperty('studentId');
  });

  it('returns empty array when no feedback exists', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .get('/api/feedback/student/no-feedback-student')
      .set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .get('/api/feedback/student/some-id')
      .set(authHeader());

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── POST /api/feedback ─────────────────────────────────────────
describe('POST /api/feedback', () => {
  const url = '/api/feedback';

  const validBody = {
    senderId: TEST_TEACHER_USER_ID,
    senderName: 'Teacher User',
    recipientId: TEST_PARENT_USER_ID,
    recipientName: 'Parent User',
    school: TEST_SCHOOL,
    subject: 'Midterm Feedback',
    body: 'Great performance on the midterm.',
    assessmentName: 'Midterm Exam',
    score: 85,
    weightPercentage: 25,
    childName: 'John Smith',
    courseName: 'Mathematics',
    studentId: 'student-uuid-1',
    studentName: 'John Smith',
  };

  it('sends feedback successfully', async () => {
    const row = buildFeedbackRow();
    // insertFeedback
    mockQueryResponse([row]);
    // SELECT email for recipient
    mockQueryResponse([{ email: 'parent@test.com' }]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('feedbackId');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({ senderId: TEST_TEACHER_USER_ID, body: 'test' });

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

  it('still succeeds when recipient has no email in DB', async () => {
    const row = buildFeedbackRow();
    // insertFeedback
    mockQueryResponse([row]);
    // SELECT email returns no rows
    mockQueryResponse([]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
  });
});

// ─── PATCH /api/feedback/:feedbackId ────────────────────────────
describe('PATCH /api/feedback/:feedbackId', () => {
  it('updates feedback successfully', async () => {
    const row = buildFeedbackRow({ subject: 'Updated Subject' });
    mockQueryResponse([row]);

    const res = await request(app)
      .patch(`/api/feedback/${row.feedback_id}`)
      .set(authHeader())
      .send({
        senderId: TEST_TEACHER_USER_ID,
        subject: 'Updated Subject',
        body: 'Updated body',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveProperty('feedbackId');
  });

  it('returns 400 when senderId is missing', async () => {
    const res = await request(app)
      .patch('/api/feedback/some-id')
      .set(authHeader())
      .send({ subject: 'Updated' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 404 when feedback not found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .patch('/api/feedback/nonexistent')
      .set(authHeader())
      .send({ senderId: TEST_TEACHER_USER_ID, body: 'Updated' });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .patch('/api/feedback/some-id')
      .set(authHeader())
      .send({ senderId: TEST_TEACHER_USER_ID, body: 'Updated' });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── DELETE /api/feedback/:feedbackId ───────────────────────────
describe('DELETE /api/feedback/:feedbackId', () => {
  it('deletes feedback successfully', async () => {
    mockQueryResponse([], 1);

    const res = await request(app)
      .delete('/api/feedback/fb-123')
      .set(authHeader())
      .send({ senderId: TEST_TEACHER_USER_ID });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toBe('Feedback deleted');
  });

  it('returns 400 when senderId is missing', async () => {
    const res = await request(app)
      .delete('/api/feedback/fb-123')
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 404 when feedback not found', async () => {
    mockQueryResponse([], 0);

    const res = await request(app)
      .delete('/api/feedback/nonexistent')
      .set(authHeader())
      .send({ senderId: TEST_TEACHER_USER_ID });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .delete('/api/feedback/fb-123')
      .set(authHeader())
      .send({ senderId: TEST_TEACHER_USER_ID });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});
