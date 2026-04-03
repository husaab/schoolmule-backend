jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const {
  mockAdminUser,
  TEST_ADMIN_USER_ID,
  TEST_PARENT_USER_ID,
  TEST_SCHOOL,
} = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildMessageRow, buildUserRow } = require('../../helpers/factories');

let app;
beforeAll(() => {
  app = getApp();
});

const authHeader = () => {
  const token = mockAdminUser();
  return { Authorization: `Bearer ${token}` };
};

// ─── GET /api/messages/sent ─────────────────────────────────────
describe('GET /api/messages/sent', () => {
  const url = '/api/messages/sent';

  it('returns sent messages for a sender', async () => {
    const messages = [
      buildMessageRow({ sender_id: TEST_ADMIN_USER_ID }),
      buildMessageRow({ sender_id: TEST_ADMIN_USER_ID, subject: 'Second' }),
    ];
    mockQueryResponse(messages);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ senderId: TEST_ADMIN_USER_ID });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(2);
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
      .query({ senderId: TEST_ADMIN_USER_ID });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── GET /api/messages/inbox ────────────────────────────────────
describe('GET /api/messages/inbox', () => {
  const url = '/api/messages/inbox';

  it('returns inbox messages for a recipient', async () => {
    const messages = [buildMessageRow({ recipient_id: TEST_PARENT_USER_ID })];
    mockQueryResponse(messages);

    const res = await request(app)
      .get(url)
      .set(authHeader())
      .query({ recipientId: TEST_PARENT_USER_ID });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toHaveLength(1);
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

// ─── POST /api/messages ─────────────────────────────────────────
describe('POST /api/messages', () => {
  const url = '/api/messages';

  it('sends a message successfully', async () => {
    const msg = buildMessageRow();
    // insertMessage
    mockQueryResponse([msg]);
    // SELECT email for recipient
    mockQueryResponse([{ email: 'parent@test.com' }]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        senderId: TEST_ADMIN_USER_ID,
        recipientId: TEST_PARENT_USER_ID,
        subject: 'Test Subject',
        body: 'Test message body',
        school: TEST_SCHOOL,
        senderName: 'Admin User',
        recipientName: 'Parent User',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toBeDefined();
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({ senderId: TEST_ADMIN_USER_ID });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toContain('Missing required fields');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        senderId: TEST_ADMIN_USER_ID,
        recipientId: TEST_PARENT_USER_ID,
        subject: 'Test',
        body: 'Test body',
        school: TEST_SCHOOL,
        senderName: 'Admin',
        recipientName: 'Parent',
      });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── PATCH /api/messages/:messageId ─────────────────────────────
describe('PATCH /api/messages/:messageId', () => {
  it('updates a message successfully', async () => {
    const msg = buildMessageRow({ subject: 'Updated Subject', body: 'Updated body' });
    mockQueryResponse([msg]);

    const res = await request(app)
      .patch(`/api/messages/${msg.message_id}`)
      .set(authHeader())
      .send({
        senderId: TEST_ADMIN_USER_ID,
        subject: 'Updated Subject',
        body: 'Updated body',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data).toBeDefined();
  });

  it('returns 400 when senderId is missing', async () => {
    const res = await request(app)
      .patch('/api/messages/some-id')
      .set(authHeader())
      .send({ subject: 'Updated' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 404 when message not found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .patch('/api/messages/nonexistent-id')
      .set(authHeader())
      .send({ senderId: TEST_ADMIN_USER_ID, subject: 'Updated' });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .patch('/api/messages/some-id')
      .set(authHeader())
      .send({ senderId: TEST_ADMIN_USER_ID, body: 'New body' });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── DELETE /api/messages/:messageId ────────────────────────────
describe('DELETE /api/messages/:messageId', () => {
  it('deletes a message successfully', async () => {
    mockQueryResponse([], 1);

    const res = await request(app)
      .delete('/api/messages/msg-123')
      .set(authHeader())
      .send({ senderId: TEST_ADMIN_USER_ID });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toBe('Message deleted');
  });

  it('returns 400 when senderId is missing', async () => {
    const res = await request(app)
      .delete('/api/messages/msg-123')
      .set(authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 404 when message not found', async () => {
    mockQueryResponse([], 0);

    const res = await request(app)
      .delete('/api/messages/nonexistent-id')
      .set(authHeader())
      .send({ senderId: TEST_ADMIN_USER_ID });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });

  it('returns 500 on database error', async () => {
    mockQueryError('DB error');

    const res = await request(app)
      .delete('/api/messages/msg-123')
      .set(authHeader())
      .send({ senderId: TEST_ADMIN_USER_ID });

    expect(res.status).toBe(500);
    expect(res.body.status).toBe('failed');
  });
});

// ─── POST /api/messages/mass/parents ────────────────────────────
describe('POST /api/messages/mass/parents', () => {
  const url = '/api/messages/mass/parents';

  it('sends mass message to all parents', async () => {
    const parents = [
      { user_id: 'parent-1', email: 'p1@test.com', first_name: 'P1', last_name: 'Last1' },
    ];
    // selectParentsBySchool
    mockQueryResponse(parents);
    // insertMessage for parent 1
    mockQueryResponse([buildMessageRow()]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        senderId: TEST_ADMIN_USER_ID,
        school: TEST_SCHOOL,
        subject: 'School Update',
        body: 'Important announcement',
        senderName: 'Admin User',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toContain('Sent to all parents');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({ senderId: TEST_ADMIN_USER_ID });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 404 when no parents found', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        senderId: TEST_ADMIN_USER_ID,
        school: TEST_SCHOOL,
        subject: 'Test',
        body: 'Test body',
        senderName: 'Admin',
      });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });
});

// ─── POST /api/messages/mass/parents/grade ──────────────────────
describe('POST /api/messages/mass/parents/grade', () => {
  const url = '/api/messages/mass/parents/grade';

  it('sends mass message to parents by grade', async () => {
    const parents = [
      { user_id: 'parent-1', email: 'p1@test.com', name: 'Parent One' },
    ];
    // selectParentsByGrade
    mockQueryResponse(parents);
    // insertMessage
    mockQueryResponse([buildMessageRow()]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        senderId: TEST_ADMIN_USER_ID,
        school: TEST_SCHOOL,
        grade: 5,
        subject: 'Grade 5 Update',
        body: 'Grade-specific announcement',
        senderName: 'Admin User',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.message).toContain('parents by grade');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({ senderId: TEST_ADMIN_USER_ID, school: TEST_SCHOOL });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 404 when no parents found for grade', async () => {
    mockQueryResponse([]);

    const res = await request(app)
      .post(url)
      .set(authHeader())
      .send({
        senderId: TEST_ADMIN_USER_ID,
        school: TEST_SCHOOL,
        grade: 99,
        subject: 'Test',
        body: 'No parents here',
        senderName: 'Admin',
      });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('failed');
  });
});
