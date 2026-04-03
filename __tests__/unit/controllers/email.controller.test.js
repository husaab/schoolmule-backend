jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: {
      send: jest.fn().mockResolvedValue({ data: { id: 'email-123' }, error: null }),
    },
  })),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser } = require('../../helpers/mockAuth');

const app = getApp();

describe('Email Controller', () => {
  // ─── POST /api/email/contact (PUBLIC route) ────────────────────
  describe('POST /api/email/contact', () => {
    const url = '/api/email/contact';

    it('should send a contact email successfully', async () => {
      const res = await request(app)
        .post(url)
        .send({
          name: 'John Doe',
          email: 'john@example.com',
          message: 'I have a question about School Mule.',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Contact email sent');
    });

    it('should return 400 when name is missing', async () => {
      const res = await request(app)
        .post(url)
        .send({
          email: 'john@example.com',
          message: 'Hello',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain('Missing');
    });

    it('should return 400 when email is missing', async () => {
      const res = await request(app)
        .post(url)
        .send({
          name: 'John Doe',
          message: 'Hello',
        });

      expect(res.status).toBe(400);
    });

    it('should return 400 when message is missing', async () => {
      const res = await request(app)
        .post(url)
        .send({
          name: 'John Doe',
          email: 'john@example.com',
        });

      expect(res.status).toBe(400);
    });

    it('should silently accept honeypot submissions (returns 200)', async () => {
      const res = await request(app)
        .post(url)
        .send({
          name: 'Bot',
          email: 'bot@spam.com',
          message: 'Buy products now',
          website: 'http://spam.com', // honeypot field
        });

      // Honeypot middleware returns 200 to not tip off the bot
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should reject URL shorteners in content', async () => {
      const res = await request(app)
        .post(url)
        .send({
          name: 'John',
          email: 'john@test.com',
          message: 'Check out bit.ly/malicious',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid content');
    });

    it('should not require authentication (public route)', async () => {
      const res = await request(app)
        .post(url)
        .send({
          name: 'Public User',
          email: 'public@test.com',
          message: 'This is a public request',
        });

      expect(res.status).toBe(200);
    });
  });

  // ─── POST /api/email/ticket (AUTHENTICATED route) ─────────────
  describe('POST /api/email/ticket', () => {
    const url = '/api/email/ticket';

    it('should send a support ticket email', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          username: 'Admin User',
          school: 'ALHAADIACADEMY',
          issueType: 'Bug Report',
          description: 'The gradebook is not loading properly.',
          contactEmail: 'admin@test.com',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Support ticket submitted');
    });

    it('should return 400 when username is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          school: 'ALHAADIACADEMY',
          issueType: 'Bug',
          description: 'Problem',
          contactEmail: 'admin@test.com',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('should return 400 when school is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          username: 'Admin',
          issueType: 'Bug',
          description: 'Problem',
          contactEmail: 'admin@test.com',
        });

      expect(res.status).toBe(400);
    });

    it('should return 400 when issueType is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          username: 'Admin',
          school: 'SCHOOL',
          description: 'Problem',
          contactEmail: 'admin@test.com',
        });

      expect(res.status).toBe(400);
    });

    it('should return 400 when description is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          username: 'Admin',
          school: 'SCHOOL',
          issueType: 'Bug',
          contactEmail: 'admin@test.com',
        });

      expect(res.status).toBe(400);
    });

    it('should return 400 when contactEmail is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          username: 'Admin',
          school: 'SCHOOL',
          issueType: 'Bug',
          description: 'Problem',
        });

      expect(res.status).toBe(400);
    });

    it('should return 401 without auth token', async () => {
      const res = await request(app)
        .post(url)
        .send({
          username: 'Admin',
          school: 'SCHOOL',
          issueType: 'Bug',
          description: 'Problem',
          contactEmail: 'admin@test.com',
        });

      expect(res.status).toBe(401);
    });
  });
});
