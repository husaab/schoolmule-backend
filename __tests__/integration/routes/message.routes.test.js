jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));

const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const RECIPIENT_USER_ID = '550e8400-e29b-41d4-a716-446655440001';

describe('Integration: Message Routes', () => {
  let app, pool;

  beforeAll(() => {
    app = getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    // Seed sender (admin)
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
      [TEST_USER_ID, 'admin@test.com', 'Admin User', 'hashed', 'Admin', 'User', 'ALHAADIACADEMY', 'ADMIN']
    );
    // Seed recipient
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true)`,
      [RECIPIENT_USER_ID, 'teacher@test.com', 'Teacher One', 'hashed', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER']
    );
  });

  // Helper to seed a message
  const seedMessage = async (overrides = {}) => {
    const defaults = {
      senderId: TEST_USER_ID,
      recipientId: RECIPIENT_USER_ID,
      school: 'ALHAADIACADEMY',
      subject: 'Test Subject',
      body: 'Test body content',
      senderName: 'Admin User',
      recipientName: 'Teacher One',
    };
    const data = { ...defaults, ...overrides };
    const { rows } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_id, school, subject, body, sender_name, recipient_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [data.senderId, data.recipientId, data.school, data.subject, data.body, data.senderName, data.recipientName]
    );
    return rows[0];
  };

  describe('POST /api/messages', () => {
    it('sends a message and persists it in the database', async () => {
      const res = await authenticatedRequest('post', '/api/messages')
        .send({
          senderId: TEST_USER_ID,
          recipientId: RECIPIENT_USER_ID,
          school: 'ALHAADIACADEMY',
          subject: 'Hello',
          body: 'How are you?',
          senderName: 'Admin User',
          recipientName: 'Teacher One',
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveProperty('message_id');
      expect(res.body.data.subject).toBe('Hello');

      const dbResult = await pool.query('SELECT * FROM messages WHERE subject = $1', ['Hello']);
      expect(dbResult.rows).toHaveLength(1);
    });

    it('returns 400 when required fields are missing', async () => {
      const res = await authenticatedRequest('post', '/api/messages')
        .send({ senderId: TEST_USER_ID, body: 'Hello' });

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });
  });

  describe('GET /api/messages/sent?senderId=', () => {
    it('returns sent messages', async () => {
      await seedMessage({ subject: 'Message 1' });
      await seedMessage({ subject: 'Message 2' });

      const res = await authenticatedRequest('get', `/api/messages/sent?senderId=${TEST_USER_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);
    });

    it('returns 400 when senderId is missing', async () => {
      const res = await authenticatedRequest('get', '/api/messages/sent');

      expect(res.status).toBe(400);
    });

    it('returns empty array when no messages exist', async () => {
      const res = await authenticatedRequest('get', `/api/messages/sent?senderId=${TEST_USER_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });
  });

  describe('GET /api/messages/inbox?recipientId=', () => {
    it('returns inbox messages', async () => {
      await seedMessage();

      const res = await authenticatedRequest('get', `/api/messages/inbox?recipientId=${RECIPIENT_USER_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    it('returns 400 when recipientId is missing', async () => {
      const res = await authenticatedRequest('get', '/api/messages/inbox');

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/messages/:messageId', () => {
    it('updates a message', async () => {
      const message = await seedMessage();

      const res = await authenticatedRequest('patch', `/api/messages/${message.message_id}`)
        .send({
          senderId: TEST_USER_ID,
          subject: 'Updated Subject',
          body: 'Updated body',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.subject).toBe('Updated Subject');
    });

    it('returns 400 when senderId is missing', async () => {
      const message = await seedMessage();

      const res = await authenticatedRequest('patch', `/api/messages/${message.message_id}`)
        .send({ subject: 'Updated' });

      expect(res.status).toBe(400);
    });

    it('returns 404 when message not found or unauthorized', async () => {
      const res = await authenticatedRequest('patch', '/api/messages/00000000-0000-0000-0000-000000000000')
        .send({ senderId: TEST_USER_ID, subject: 'Test' });

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/messages/:messageId', () => {
    it('deletes a message', async () => {
      const message = await seedMessage();

      const res = await authenticatedRequest('delete', `/api/messages/${message.message_id}`)
        .send({ senderId: TEST_USER_ID });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');

      const dbResult = await pool.query('SELECT * FROM messages WHERE message_id = $1', [message.message_id]);
      expect(dbResult.rows).toHaveLength(0);
    });

    it('returns 400 when senderId is missing', async () => {
      const message = await seedMessage();

      const res = await authenticatedRequest('delete', `/api/messages/${message.message_id}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 404 when message not found or unauthorized', async () => {
      const res = await authenticatedRequest('delete', '/api/messages/00000000-0000-0000-0000-000000000000')
        .send({ senderId: TEST_USER_ID });

      expect(res.status).toBe(404);
    });
  });

  describe('Authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get(`/api/messages/sent?senderId=${TEST_USER_ID}`);

      expect(res.status).toBe(401);
    });
  });
});
