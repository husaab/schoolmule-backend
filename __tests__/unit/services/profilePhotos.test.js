const db = require('../../../config/database');
const supabase = require('../../../config/supabaseClient');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const { photosAllowed, signedPhotoUrl, photoUrlFor, removePhotoObject, BUCKET } = require('../../../services/profile/photos');

const settings = (studentPhotos) => ({ school: 'ALHAADIACADEMY', enabled: true, student_photos: studentPhotos, updated_at: null });
const teacher = { role: 'TEACHER', school: 'ALHAADIACADEMY', photo_path: 'ALHAADIACADEMY/u/1.png' };
const student = { ...teacher, role: 'STUDENT' };

describe('profile photos', () => {
  it('uses the private avatars bucket', () => {
    expect(BUCKET).toBe('avatars');
  });

  describe('photosAllowed', () => {
    it('is always true for adults, without reading the school settings', async () => {
      expect(await photosAllowed({ role: 'TEACHER', school: 'ALHAADIACADEMY' })).toBe(true);
      expect(await photosAllowed({ role: 'PARENT', school: 'ALHAADIACADEMY' })).toBe(true);
      expect(db.query).not.toHaveBeenCalled();
    });

    it("follows the school's student_photos setting for students, off when the school never saved settings", async () => {
      mockQueryResponse([settings(true)]);
      expect(await photosAllowed({ role: 'STUDENT', school: 'ALHAADIACADEMY' })).toBe(true);
      mockQueryResponse([settings(false)]);
      expect(await photosAllowed({ role: 'STUDENT', school: 'ALHAADIACADEMY' })).toBe(false);
      mockQueryResponse([]);
      expect(await photosAllowed({ role: 'STUDENT', school: 'ALHAADIACADEMY' })).toBe(false);
    });
  });

  describe('signedPhotoUrl', () => {
    it('signs a path in the avatars bucket', async () => {
      expect(await signedPhotoUrl('S/u/1.png')).toBe('https://mock-signed-url.com');
      expect(supabase.storage.from).toHaveBeenCalledWith('avatars');
      expect(supabase._mockStorage.createSignedUrl).toHaveBeenCalledWith('S/u/1.png', expect.any(Number));
    });

    it('is null for no path, and null (never a throw) when signing fails', async () => {
      expect(await signedPhotoUrl(null)).toBeNull();
      supabase._mockStorage.createSignedUrl.mockResolvedValueOnce({ data: null, error: { message: 'nope' } });
      expect(await signedPhotoUrl('S/u/1.png')).toBeNull();
      supabase._mockStorage.createSignedUrl.mockRejectedValueOnce(new Error('network'));
      expect(await signedPhotoUrl('S/u/1.png')).toBeNull();
    });
  });

  describe('photoUrlFor', () => {
    it('is null without a stored photo, and does not touch the database', async () => {
      expect(await photoUrlFor({ role: 'STUDENT', school: 'ALHAADIACADEMY', photo_path: null })).toBeNull();
      expect(await photoUrlFor({ role: 'TEACHER' })).toBeNull();
      expect(await photoUrlFor(null)).toBeNull();
      expect(db.query).not.toHaveBeenCalled();
    });

    it('signs an adult\'s photo', async () => {
      expect(await photoUrlFor(teacher)).toBe('https://mock-signed-url.com');
    });

    it('signs a student\'s photo only while the school allows student photos', async () => {
      mockQueryResponse([settings(true)]);
      expect(await photoUrlFor(student)).toBe('https://mock-signed-url.com');
      mockQueryResponse([settings(false)]);
      expect(await photoUrlFor(student)).toBeNull();
    });

    it('never throws: a failing settings read means no photo', async () => {
      mockQueryError('db down');
      expect(await photoUrlFor(student)).toBeNull();
    });
  });

  describe('removePhotoObject', () => {
    it('removes the object from the bucket, ignores no path, and swallows storage errors', async () => {
      await removePhotoObject(null);
      expect(supabase._mockStorage.remove).not.toHaveBeenCalled();
      await removePhotoObject('S/u/1.png');
      expect(supabase._mockStorage.remove).toHaveBeenCalledWith(['S/u/1.png']);
      supabase._mockStorage.remove.mockRejectedValueOnce(new Error('network'));
      await expect(removePhotoObject('S/u/2.png')).resolves.toBeUndefined();
    });
  });
});
