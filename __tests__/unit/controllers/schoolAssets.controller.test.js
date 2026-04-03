const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { buildSchoolAssetRow, buildSchoolRow } = require('../../helpers/factories');

const app = getApp();

describe('School Assets Controller', () => {
  // ─── GET /api/school-assets/school-code/:schoolCode ────────────
  describe('GET /api/school-assets/school-code/:schoolCode', () => {
    it('should return school assets by school code', async () => {
      const token = mockAdminUser();
      const row = buildSchoolAssetRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .get(`/api/school-assets/school-code/${TEST_SCHOOL}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).not.toBeNull();
      expect(res.body.data.schoolCode).toBe(row.school_code);
      expect(res.body.data.logoPath).toBe(row.logo_path);
    });

    it('should return null when no assets found', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .get(`/api/school-assets/school-code/${TEST_SCHOOL}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get(`/api/school-assets/school-code/${TEST_SCHOOL}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
      expect(res.body.status).toBe('error');
    });

    it('should return 401 without auth token', async () => {
      const res = await request(app).get(`/api/school-assets/school-code/${TEST_SCHOOL}`);
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/school-assets/school-id/:schoolId ────────────────
  describe('GET /api/school-assets/school-id/:schoolId', () => {
    it('should return school assets by school ID', async () => {
      const token = mockAdminUser();
      const row = buildSchoolAssetRow();
      mockQueryResponse([row]);

      const res = await request(app)
        .get(`/api/school-assets/school-id/${row.school_id}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).not.toBeNull();
    });

    it('should return null when no assets found', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);

      const res = await request(app)
        .get('/api/school-assets/school-id/some-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeNull();
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .get('/api/school-assets/school-id/some-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });

  // ─── POST /api/school-assets/upload ────────────────────────────
  describe('POST /api/school-assets/upload', () => {
    const url = '/api/school-assets/upload';

    it('should upload a logo asset', async () => {
      const token = mockAdminUser();
      const schoolRow = buildSchoolRow({ school_code: TEST_SCHOOL });
      const assetRow = buildSchoolAssetRow({ logo_path: 'ALHAADIACADEMY/logo.png' });

      // 1. SELECT school_id FROM schools
      mockQueryResponse([schoolRow]);
      // 2. SELECT existing assets
      mockQueryResponse([]);
      // 3. UPSERT
      mockQueryResponse([assetRow]);

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .field('schoolCode', TEST_SCHOOL)
        .field('assetType', 'logo')
        .attach('file', Buffer.from('fake-image'), {
          filename: 'logo.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.uploadedAsset).toBe('logo');
    });

    it('should return 400 when schoolCode is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .field('assetType', 'logo')
        .attach('file', Buffer.from('fake-image'), {
          filename: 'logo.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(400);
    });

    it('should return 400 when assetType is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .field('schoolCode', TEST_SCHOOL)
        .attach('file', Buffer.from('fake-image'), {
          filename: 'logo.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(400);
    });

    it('should return 400 when no file provided', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .field('schoolCode', TEST_SCHOOL)
        .field('assetType', 'logo');

      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid asset type', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .field('schoolCode', TEST_SCHOOL)
        .field('assetType', 'invalid_type')
        .attach('file', Buffer.from('fake-image'), {
          filename: 'logo.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid asset type');
    });

    it('should return 404 when school not found', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]); // school not found

      const res = await request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .field('schoolCode', 'NONEXISTENT')
        .field('assetType', 'logo')
        .attach('file', Buffer.from('fake-image'), {
          filename: 'logo.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(404);
    });
  });

  // ─── DELETE /api/school-assets/:schoolId/:assetType ────────────
  describe('DELETE /api/school-assets/:schoolId/:assetType', () => {
    it('should delete a logo asset', async () => {
      const token = mockAdminUser();
      const assetRow = buildSchoolAssetRow();
      const updatedRow = { ...assetRow, logo_path: null };

      // 1. SELECT existing assets
      mockQueryResponse([assetRow]);
      // 2. UPSERT with null path
      mockQueryResponse([updatedRow]);

      const res = await request(app)
        .delete(`/api/school-assets/${assetRow.school_id}/logo`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toBe('Asset deleted successfully');
    });

    it('should return 400 for invalid asset type', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .delete('/api/school-assets/some-school-id/invalid_type')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Invalid asset type');
    });

    it('should return 404 when school assets not found', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]); // no existing assets

      const res = await request(app)
        .delete('/api/school-assets/some-school-id/logo')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(404);
    });

    it('should return 500 on database error', async () => {
      const token = mockAdminUser();
      mockQueryError('DB failure');

      const res = await request(app)
        .delete('/api/school-assets/some-school-id/logo')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(500);
    });
  });

  // ─── GET /api/school-assets/all ────────────────────────────────
  describe('GET /api/school-assets/all', () => {
    const url = '/api/school-assets/all';

    it('should return all schools with assets', async () => {
      const token = mockAdminUser();
      const rows = [buildSchoolAssetRow(), buildSchoolAssetRow()];
      mockQueryResponse(rows);

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(2);
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

  // ─── GET /api/school-assets/folder-url/:schoolCode ─────────────
  describe('GET /api/school-assets/folder-url/:schoolCode', () => {
    it('should return the public bucket URL for a school', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(`/api/school-assets/folder-url/${TEST_SCHOOL}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.schoolFolder).toBe(TEST_SCHOOL);
      expect(res.body.data.baseUrl).toContain('school-assets');
      expect(res.body.data.fullPath).toContain(TEST_SCHOOL);
      expect(res.body.data.expiresIn).toBeNull();
    });
  });

  // ─── GET /api/school-assets/signed-url ─────────────────────────
  describe('GET /api/school-assets/signed-url', () => {
    const url = '/api/school-assets/signed-url';

    it('should return a signed URL', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ filePath: 'ALHAADIACADEMY/logo.png' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.signedUrl).toBe('https://mock-signed-url.com');
      expect(res.body.data.expiresIn).toBe(3600);
    });

    it('should return 400 when filePath is missing', async () => {
      const token = mockAdminUser();

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
    });

    it('should return 500 when supabase createSignedUrl fails', async () => {
      const token = mockAdminUser();
      const supabase = require('../../__mocks__/config/supabaseClient');
      supabase._mockStorage.createSignedUrl.mockResolvedValueOnce({
        data: null,
        error: { message: 'Storage error' },
      });

      const res = await request(app)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .query({ filePath: 'some/path.png' });

      expect(res.status).toBe(500);
    });
  });
});
