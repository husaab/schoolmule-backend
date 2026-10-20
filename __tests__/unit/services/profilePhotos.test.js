const db = require('../../../config/database');
const supabase = require('../../../config/supabaseClient');
const { mockQueryResponse, mockQueryError } = require('../../helpers/mockDb');
const {
  photosAllowed, signedPhotoUrl, signedPhotoUrls, photoUrlFor, photoUrlsFor, withPhotoUrls, removePhotoObject, BUCKET, SIGNED_URL_TTL,
} = require('../../../services/profile/photos');

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
      expect(await signedPhotoUrl('S/u/2.png')).toBeNull();
      supabase._mockStorage.createSignedUrl.mockRejectedValueOnce(new Error('network'));
      expect(await signedPhotoUrl('S/u/3.png')).toBeNull();
    });

    it('hands out the same URL again while it has time left, so a polled page keeps one picture', async () => {
      const first = await signedPhotoUrl('S/u/4.png');
      supabase._mockStorage.createSignedUrl.mockResolvedValueOnce({ data: { signedUrl: 'https://other' }, error: null });
      expect(await signedPhotoUrl('S/u/4.png')).toBe(first);
      expect(supabase._mockStorage.createSignedUrl).toHaveBeenCalledTimes(1);
    });

    it('signs again once the cached URL is close to expiring', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        await signedPhotoUrl('S/u/5.png');
        now.mockReturnValue(1_000_000 + (SIGNED_URL_TTL - 30 * 60) * 1000);
        supabase._mockStorage.createSignedUrl.mockResolvedValueOnce({ data: { signedUrl: 'https://fresh' }, error: null });
        expect(await signedPhotoUrl('S/u/5.png')).toBe('https://fresh');
      } finally {
        now.mockRestore();
      }
    });

    it('does not remember a failure', async () => {
      supabase._mockStorage.createSignedUrl.mockRejectedValueOnce(new Error('network'));
      expect(await signedPhotoUrl('S/u/6.png')).toBeNull();
      expect(await signedPhotoUrl('S/u/6.png')).toBe('https://mock-signed-url.com');
    });
  });

  describe('signedPhotoUrls', () => {
    it('signs every distinct path in one storage call', async () => {
      const urls = await signedPhotoUrls(['M/a.png', 'M/b.png', 'M/a.png', null, '']);
      expect(supabase._mockStorage.createSignedUrls).toHaveBeenCalledTimes(1);
      expect(supabase._mockStorage.createSignedUrls).toHaveBeenCalledWith(['M/a.png', 'M/b.png'], SIGNED_URL_TTL);
      expect(urls.get('M/a.png')).toBe('https://mock-signed-url.com/M/a.png');
      expect(urls.get('M/b.png')).toBe('https://mock-signed-url.com/M/b.png');
      expect(urls.size).toBe(2);
    });

    it('reuses URLs it signed before and only signs the new paths', async () => {
      await signedPhotoUrls(['M/c.png']);
      const urls = await signedPhotoUrls(['M/c.png', 'M/d.png']);
      expect(supabase._mockStorage.createSignedUrls).toHaveBeenLastCalledWith(['M/d.png'], SIGNED_URL_TTL);
      expect(urls.get('M/c.png')).toBe('https://mock-signed-url.com/M/c.png');
    });

    it('makes no storage call when nothing needs signing', async () => {
      expect((await signedPhotoUrls([])).size).toBe(0);
      expect((await signedPhotoUrls([null, undefined])).size).toBe(0);
      expect(supabase._mockStorage.createSignedUrls).not.toHaveBeenCalled();
    });

    it('leaves out paths that fail, and never throws', async () => {
      supabase._mockStorage.createSignedUrls.mockResolvedValueOnce({
        data: [{ path: 'M/e.png', signedUrl: 'https://e' }, { path: 'M/f.png', signedUrl: null, error: 'Object not found' }],
        error: null,
      });
      const urls = await signedPhotoUrls(['M/e.png', 'M/f.png']);
      expect(urls.get('M/e.png')).toBe('https://e');
      expect(urls.has('M/f.png')).toBe(false);
      supabase._mockStorage.createSignedUrls.mockRejectedValueOnce(new Error('network'));
      expect((await signedPhotoUrls(['M/g.png'])).size).toBe(0);
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

  describe('photoUrlsFor', () => {
    const adult = (path) => ({ photo_path: path, role: 'TEACHER' });
    const kid = (path) => ({ photo_path: path, role: 'STUDENT' });

    it("signs adults' photos without reading the school settings", async () => {
      const urls = await photoUrlsFor([adult('P/t.png'), { photo_path: 'P/p.png', role: 'PARENT' }, adult(null)], 'ALHAADIACADEMY');
      expect(urls.get('P/t.png')).toBe('https://mock-signed-url.com/P/t.png');
      expect(urls.get('P/p.png')).toBe('https://mock-signed-url.com/P/p.png');
      expect(db.query).not.toHaveBeenCalled();
    });

    it("leaves students' photos out while the school has student photos off", async () => {
      mockQueryResponse([settings(false)]);
      const urls = await photoUrlsFor([adult('P/t2.png'), kid('P/s.png')], 'ALHAADIACADEMY');
      expect(urls.has('P/s.png')).toBe(false);
      expect(urls.get('P/t2.png')).toBe('https://mock-signed-url.com/P/t2.png');
    });

    it("signs students' photos while the school allows them", async () => {
      mockQueryResponse([settings(true)]);
      const urls = await photoUrlsFor([kid('P/s2.png')], 'ALHAADIACADEMY');
      expect(urls.get('P/s2.png')).toBe('https://mock-signed-url.com/P/s2.png');
    });

    it('never throws: a failing settings read means no student photos', async () => {
      mockQueryError('db down');
      const urls = await photoUrlsFor([adult('P/t3.png'), kid('P/s3.png')], 'ALHAADIACADEMY');
      expect(urls.has('P/s3.png')).toBe(false);
      expect(urls.get('P/t3.png')).toBe('https://mock-signed-url.com/P/t3.png');
    });
  });

  describe('withPhotoUrls', () => {
    it('sets photo_url on each row: the signed URL, else null', async () => {
      const rows = [{ user_id: 'a', photo_path: 'W/a.png', role: 'TEACHER' }, { user_id: 'b', photo_path: null, role: 'PARENT' }];
      const out = await withPhotoUrls(rows, 'ALHAADIACADEMY');
      expect(out).toEqual([
        { user_id: 'a', photo_path: 'W/a.png', role: 'TEACHER', photo_url: 'https://mock-signed-url.com/W/a.png' },
        { user_id: 'b', photo_path: null, role: 'PARENT', photo_url: null },
      ]);
      expect(rows[0]).not.toHaveProperty('photo_url');
    });

    it('treats every row as the given role: student rows follow the school setting', async () => {
      const rows = [{ student_id: 's1', photo_path: 'W/s1.png' }];
      mockQueryResponse([settings(false)]);
      expect((await withPhotoUrls(rows, 'ALHAADIACADEMY', { role: 'STUDENT' }))[0].photo_url).toBeNull();
      mockQueryResponse([settings(true)]);
      expect((await withPhotoUrls(rows, 'ALHAADIACADEMY', { role: 'STUDENT' }))[0].photo_url).toBe('https://mock-signed-url.com/W/s1.png');
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
