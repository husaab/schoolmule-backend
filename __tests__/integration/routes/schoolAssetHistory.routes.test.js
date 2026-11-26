jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient'); // the storage mock

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000'; // authenticatedRequest's default account
const TEACHER = { userId: '550e8400-e29b-41d4-a716-446655440051', role: 'TEACHER', email: 'assets-teacher@test.com' };
const LIVE_PNG = 'ALHAADIACADEMY/school_stamp.png';

// Replacing or deleting a school's logo, signature or stamp used to destroy
// the old file. Now it is kept as an earlier version that can be restored.
describe('school asset history', () => {
  let pool, schoolId;
  const storage = supabase._mockStorage;

  beforeAll(() => {
    getApp();
    pool = getTestPool();
  });

  beforeEach(async () => {
    supabase._reset();
    // By default the live bucket holds the stamp, and it can be read.
    storage.list.mockResolvedValue({ data: [{ name: 'school_stamp.png' }], error: null });
    storage.download.mockImplementation(async () => ({ data: new Blob(['old-bytes'], { type: 'image/png' }), error: null }));

    const { rows } = await pool.query(`SELECT school_id FROM schools WHERE school_code = 'ALHAADIACADEMY'`);
    schoolId = rows[0].school_id;
    await pool.query(
      `INSERT INTO school_assets (school_id, school_code, school_stamp_path, logo_path) VALUES ($1, 'ALHAADIACADEMY', $2, 'ALHAADIACADEMY/logo.png')`,
      [schoolId, LIVE_PNG]);
  });

  const upload = (filename = 'stamp.png', contentType = 'image/png', token) =>
    authenticatedRequest('post', '/api/school-assets/upload', token)
      .field('schoolCode', 'ALHAADIACADEMY')
      .field('assetType', 'school_stamp')
      .attach('file', Buffer.from('new-bytes'), { filename, contentType });
  const versions = async () => (await pool.query(
    `SELECT version_id, asset_type, storage_path, live_ext, content_type, byte_size, replaced_by, reason
     FROM school_asset_versions ORDER BY replaced_at, version_id`)).rows;
  const livePaths = async () => (await pool.query(
    `SELECT school_stamp_path, logo_path FROM school_assets WHERE school_id = $1`, [schoolId])).rows[0];
  const audits = async () => (await pool.query(`SELECT action, summary, changes, actor_user_id FROM audit_log ORDER BY ts`)).rows;
  const uploadedPaths = () => storage.upload.mock.calls.map(([objectPath]) => objectPath);

  describe('replacing', () => {
    it('keeps the old file as a version before overwriting it', async () => {
      const res = await upload();

      expect(res.status).toBe(200);
      const kept = await versions();
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({
        asset_type: 'school_stamp', live_ext: '.png', content_type: 'image/png',
        byte_size: Buffer.byteLength('old-bytes'), replaced_by: ADMIN_ID, reason: 'replaced',
      });
      expect(kept[0].storage_path).toBe(`ALHAADIACADEMY/school_stamp/${kept[0].version_id}.png`);
      expect(res.body.data.keptVersionId).toBe(kept[0].version_id);
      // The copy is written first, then the live file.
      expect(uploadedPaths()).toEqual([kept[0].storage_path, LIVE_PNG]);
      expect(supabase.storage.from.mock.calls.map(([bucket]) => bucket)).toContain('school-assets-history');
    });

    it('logs who replaced what', async () => {
      await upload();
      expect(await audits()).toEqual([{
        action: 'school_asset.replace', summary: 'School stamp replaced', actor_user_id: ADMIN_ID,
        changes: [{ key: 'school_stamp', label: 'School stamp', before: LIVE_PNG, after: LIVE_PNG }],
      }]);
    });

    it('removes the old live file when the new one has another extension', async () => {
      const res = await upload('stamp.jpg', 'image/jpeg');

      expect(res.status).toBe(200);
      expect((await livePaths()).school_stamp_path).toBe('ALHAADIACADEMY/school_stamp.jpg');
      expect(storage.remove).toHaveBeenCalledWith([LIVE_PNG]);
    });

    it('overwrites nothing when the old file cannot be kept', async () => {
      storage.upload.mockResolvedValueOnce({ data: null, error: { message: 'bucket unavailable' } });

      const res = await upload('stamp.jpg', 'image/jpeg');

      expect(res.status).toBe(500);
      expect(res.body.code).toBe('ASSET_COPY_FAILED');
      expect(storage.upload).toHaveBeenCalledTimes(1); // only the failed copy; the live file was never written
      expect((await livePaths()).school_stamp_path).toBe(LIVE_PNG);
      expect(await versions()).toEqual([]);
      expect(await audits()).toEqual([]);
    });

    it('overwrites nothing when the old file cannot be read', async () => {
      storage.download.mockResolvedValue({ data: null, error: { message: 'read failed' } });
      const res = await upload();
      expect(res.status).toBe(500);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('just uploads when there is no live file to keep', async () => {
      storage.list.mockResolvedValue({ data: [], error: null });

      const res = await upload();

      expect(res.status).toBe(200);
      expect(res.body.data.keptVersionId).toBeNull();
      expect(await versions()).toEqual([]);
      expect(uploadedPaths()).toEqual([LIVE_PNG]);
    });

    it('keeps the newest ten versions and removes the oldest', async () => {
      const { rows } = await pool.query(
        `INSERT INTO school_asset_versions (school_id, school, asset_type, storage_path, live_ext, reason, replaced_at)
         SELECT $1, 'ALHAADIACADEMY', 'school_stamp', 'ALHAADIACADEMY/school_stamp/old-' || n || '.png', '.png', 'replaced',
                NOW() - (n || ' days')::interval
         FROM generate_series(1, 10) AS n
         RETURNING storage_path, replaced_at`, [schoolId]);
      const oldest = rows.sort((a, b) => a.replaced_at - b.replaced_at)[0].storage_path;

      await upload();

      const kept = await versions();
      expect(kept).toHaveLength(10);
      expect(kept.map((v) => v.storage_path)).not.toContain(oldest);
      expect(storage.remove).toHaveBeenCalledWith([oldest]);
    });
  });

  describe('deleting', () => {
    it('keeps the file as a version, then clears the path', async () => {
      const res = await authenticatedRequest('delete', `/api/school-assets/${schoolId}/school_stamp`);

      expect(res.status).toBe(200);
      expect((await livePaths()).school_stamp_path).toBeNull();
      expect(await versions()).toEqual([expect.objectContaining({ reason: 'deleted', live_ext: '.png' })]);
      expect(storage.remove).toHaveBeenCalledWith([LIVE_PNG]);
      expect((await audits())[0]).toMatchObject({ action: 'school_asset.delete', summary: 'School stamp removed' });
    });

    it('deletes nothing when the file cannot be kept', async () => {
      storage.upload.mockResolvedValueOnce({ data: null, error: { message: 'bucket unavailable' } });

      const res = await authenticatedRequest('delete', `/api/school-assets/${schoolId}/school_stamp`);

      expect(res.status).toBe(500);
      expect(storage.remove).not.toHaveBeenCalled();
      expect((await livePaths()).school_stamp_path).toBe(LIVE_PNG);
    });
  });

  describe('earlier versions', () => {
    const seedVersion = async (overrides = {}) => {
      const v = { asset_type: 'school_stamp', storage_path: 'ALHAADIACADEMY/school_stamp/v1.png', live_ext: '.png', age: '1 day', ...overrides };
      const { rows } = await pool.query(
        `INSERT INTO school_asset_versions (school_id, school, asset_type, storage_path, live_ext, content_type, byte_size, replaced_by, reason, replaced_at)
         VALUES ($1, 'ALHAADIACADEMY', $2, $3, $4, 'image/png', 9, $5, 'replaced', NOW() - $6::interval) RETURNING version_id`,
        [schoolId, v.asset_type, v.storage_path, v.live_ext, v.replaced_by || null, v.age]);
      return rows[0].version_id;
    };
    const list = (type = 'school_stamp', token) => authenticatedRequest('get', `/api/school-assets/${schoolId}/${type}/versions`, token);
    const restore = (versionId, type = 'school_stamp', token) =>
      authenticatedRequest('post', `/api/school-assets/${schoolId}/${type}/versions/${versionId}/restore`, token);

    it('are listed newest first, for that asset only, with a preview link and who replaced them', async () => {
      await authenticatedRequest('get', '/api/school-years'); // creates the default admin account
      const older = await seedVersion({ storage_path: 'ALHAADIACADEMY/school_stamp/older.png', age: '3 days' });
      const newer = await seedVersion({ storage_path: 'ALHAADIACADEMY/school_stamp/newer.png', age: '1 day', replaced_by: ADMIN_ID });
      await seedVersion({ asset_type: 'logo', storage_path: 'ALHAADIACADEMY/logo/x.png' });

      const res = await list();

      expect(res.status).toBe(200);
      expect(res.body.data.map((v) => v.versionId)).toEqual([newer, older]);
      expect(res.body.data[0]).toMatchObject({
        reason: 'replaced', byteSize: 9, contentType: 'image/png', replacedByName: 'Test User',
        previewUrl: 'https://mock-signed-url.com/ALHAADIACADEMY/school_stamp/newer.png',
      });
      expect(res.body.data[0]).not.toHaveProperty('storagePath');
    });

    it('can be restored: the live file is kept first, then replaced', async () => {
      // The live stamp is now a .jpg; the version being restored was a .png.
      await pool.query(`UPDATE school_assets SET school_stamp_path = 'ALHAADIACADEMY/school_stamp.jpg' WHERE school_id = $1`, [schoolId]);
      storage.list.mockResolvedValue({ data: [{ name: 'school_stamp.jpg' }], error: null });
      const versionId = await seedVersion();

      const res = await restore(versionId);

      expect(res.status).toBe(200);
      expect(res.body.data.filePath).toBe(LIVE_PNG);
      expect((await livePaths()).school_stamp_path).toBe(LIVE_PNG);
      expect((await livePaths()).logo_path).toBe('ALHAADIACADEMY/logo.png'); // the other assets are left alone
      const reasons = (await versions()).map((v) => v.reason).sort();
      expect(reasons).toEqual(['replaced', 'restored_over']);
      expect(uploadedPaths().at(-1)).toBe(LIVE_PNG);
      expect(storage.remove).toHaveBeenCalledWith(['ALHAADIACADEMY/school_stamp.jpg']);
      expect((await audits()).at(-1)).toMatchObject({
        action: 'school_asset.restore',
        changes: [{ key: 'school_stamp', label: 'School stamp', before: 'ALHAADIACADEMY/school_stamp.jpg', after: LIVE_PNG }],
      });
    });

    it('changes nothing when the version\'s copy cannot be read', async () => {
      const versionId = await seedVersion();
      storage.download.mockResolvedValue({ data: null, error: { message: 'gone' } });

      const res = await restore(versionId);

      expect(res.status).toBe(500);
      expect(storage.upload).not.toHaveBeenCalled();
      expect((await livePaths()).school_stamp_path).toBe(LIVE_PNG);
    });

    it('answers 404 for a version of another asset, an unknown id and a malformed id', async () => {
      const logoVersion = await seedVersion({ asset_type: 'logo', storage_path: 'ALHAADIACADEMY/logo/x.png' });
      expect((await restore(logoVersion)).status).toBe(404);
      expect((await restore('550e8400-e29b-41d4-a716-4466554400ff')).status).toBe(404);
      expect((await restore('not-an-id')).status).toBe(404);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('are for School setup holders of this school only', async () => {
      const versionId = await seedVersion();
      expect((await list('school_stamp', TEACHER)).status).toBe(403);
      expect((await restore(versionId, 'school_stamp', TEACHER)).status).toBe(403);

      const { rows } = await pool.query(
        `INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT (school_code) DO UPDATE SET name = EXCLUDED.name RETURNING school_id`);
      const other = await authenticatedRequest('get', `/api/school-assets/${rows[0].school_id}/school_stamp/versions`);
      expect(other.status).toBe(404);
      expect((await list('favicon')).status).toBe(400);
    });
  });
});
