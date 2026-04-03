const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const {
  mockAdminUser,
  mockTeacherUser,
  TEST_ADMIN_USER_ID,
} = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildPatchNoteRow, buildPatchNoteDismissalRow } = require('../../helpers/factories');

const app = getApp();

describe('Patch Note Controller', () => {
  // ─── GET /api/patch-notes ──────────────────────────────────────
  describe('GET /api/patch-notes', () => {
    const url = '/api/patch-notes';

    it('should return patch notes for user role', async () => {
      const token = mockAdminUser();
      const rows = [buildPatchNoteRow(), buildPatchNoteRow({ title: 'Bug Fix' })];
      mockQueryResponse(rows);

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0]).toHaveProperty('patchNoteId');
      expect(res.body.data[0]).toHaveProperty('title');
      expect(res.body.data[0]).toHaveProperty('version');
    });

    it('should return patch notes for teacher role', async () => {
      const token = mockTeacherUser();
      const rows = [buildPatchNoteRow({ target_roles: ['TEACHER'] })];
      mockQueryResponse(rows);

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });

    it('should return 401 without auth token', async () => {
      const res = await request(app).get(url);
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/patch-notes/unread ───────────────────────────────
  describe('GET /api/patch-notes/unread', () => {
    const url = '/api/patch-notes/unread';

    it('should return unread patch notes', async () => {
      const token = mockAdminUser();
      const rows = [buildPatchNoteRow()];
      mockQueryResponse(rows);

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.hasUnread).toBe(true);
      expect(res.body.data.notes).toHaveLength(1);
    });

    it('should return hasUnread false when no unread notes', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.hasUnread).toBe(false);
      expect(res.body.data.notes).toHaveLength(0);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });

  // ─── POST /api/patch-notes/dismiss ─────────────────────────────
  describe('POST /api/patch-notes/dismiss', () => {
    const url = '/api/patch-notes/dismiss';

    it('should dismiss patch notes', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ lastSeenPatchNoteId: 'some-id' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toBe('Dismissed');
    });

    it('should return 400 when lastSeenPatchNoteId is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ lastSeenPatchNoteId: 'some-id' });

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/patch-notes/all ──────────────────────────────────
  describe('GET /api/patch-notes/all', () => {
    const url = '/api/patch-notes/all';

    it('should return all patch notes for admin', async () => {
      const token = mockAdminUser();
      const rows = [buildPatchNoteRow(), buildPatchNoteRow()];
      mockQueryResponse(rows);

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);
    });

    it('should return 403 for non-admin', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
      expect(res.body.message).toBe('Admin access required');
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });

  // ─── POST /api/patch-notes/create ──────────────────────────────
  describe('POST /api/patch-notes/create', () => {
    const url = '/api/patch-notes/create';

    it('should create a patch note as admin', async () => {
      const token = mockAdminUser();
      const row = buildPatchNoteRow({ created_by: TEST_ADMIN_USER_ID });
      mockQueryResponse([row]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'New Feature',
          body: 'Description of the new feature',
          version: '1.3.0',
          category: 'feature',
          targetRoles: ['ADMIN', 'TEACHER'],
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('success');
      expect(res.body.data.patchNoteId).toBeDefined();
    });

    it('should return 403 for non-admin', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'New Feature',
          body: 'Description',
          version: '1.3.0',
          category: 'feature',
          targetRoles: ['ADMIN'],
        });

      expect(res.status).toBe(403);
    });

    it('should return 400 when required fields are missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Incomplete' });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Missing required fields');
    });

    it('should return 400 when targetRoles is empty', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Title',
          body: 'Body',
          version: '1.0',
          category: 'fix',
          targetRoles: [],
        });

      expect(res.status).toBe(400);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Title',
          body: 'Body',
          version: '1.0',
          category: 'fix',
          targetRoles: ['ADMIN'],
        });

      expect(res.status).toBe(500);
    });
  });

  // ─── PATCH /api/patch-notes/:id ────────────────────────────────
  describe('PATCH /api/patch-notes/:id', () => {
    it('should update a patch note as admin', async () => {
      const token = mockAdminUser();
      const row = buildPatchNoteRow({ title: 'Updated Title' });
      mockQueryResponse([row]);

      const res = await request(app)
        .patch(`/api/patch-notes/${row.patch_note_id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Updated Title' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('should return 403 for non-admin', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .patch('/api/patch-notes/some-id')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Update' });

      expect(res.status).toBe(403);
    });

    it('should return 404 when patch note not found', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .patch('/api/patch-notes/nonexistent')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Update' });

      expect(res.status).toBe(404);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .patch('/api/patch-notes/some-id')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Update' });

      expect(res.status).toBe(500);
    });
  });

  // ─── DELETE /api/patch-notes/:id ───────────────────────────────
  describe('DELETE /api/patch-notes/:id', () => {
    it('should delete a patch note as admin', async () => {
      const token = mockAdminUser();
      mockQueryResponse([], 1);

      const res = await request(app)
        .delete('/api/patch-notes/some-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toBe('Deleted');
    });

    it('should return 403 for non-admin', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .delete('/api/patch-notes/some-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(403);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .delete('/api/patch-notes/some-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });

  // ─── POST /api/patch-notes/:id/image ───────────────────────────
  describe('POST /api/patch-notes/:id/image', () => {
    it('should upload an image for a patch note', async () => {
      const token = mockAdminUser();
      const row = buildPatchNoteRow({ image_url: 'https://mock-public-url.com' });
      // First query: updateImageUrl
      mockQueryResponse([row]);

      const res = await request(app)
        .post('/api/patch-notes/some-id/image')
        .set('Authorization', `Bearer ${token}`)
        .attach('image', Buffer.from('fake-image'), {
          filename: 'test.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.imageUrl).toBeDefined();
    });

    it('should return 403 for non-admin', async () => {
      const token = mockTeacherUser();

      const res = await request(app)
        .post('/api/patch-notes/some-id/image')
        .set('Authorization', `Bearer ${token}`)
        .attach('image', Buffer.from('fake-image'), {
          filename: 'test.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(403);
    });

    it('should return 400 when no file provided', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post('/api/patch-notes/some-id/image')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('No image file provided');
    });

    it('should return 404 when patch note not found after upload', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]); // updateImageUrl returns no rows

      const res = await request(app)
        .post('/api/patch-notes/some-id/image')
        .set('Authorization', `Bearer ${token}`)
        .attach('image', Buffer.from('fake-image'), {
          filename: 'test.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(404);
    });

    it('should return 500 when supabase upload fails', async () => {
      const token = mockAdminUser();
      const supabase = require('../../__mocks__/config/supabaseClient');
      supabase._mockStorage.upload.mockResolvedValueOnce({
        data: null,
        error: { message: 'Upload failed' },
      });

      const res = await request(app)
        .post('/api/patch-notes/some-id/image')
        .set('Authorization', `Bearer ${token}`)
        .attach('image', Buffer.from('fake-image'), {
          filename: 'test.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(500);
    });
  });
});
