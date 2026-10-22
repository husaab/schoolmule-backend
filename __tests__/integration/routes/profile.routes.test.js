// The signed-in person's own avatar and photo (/api/profile), and how both
// ride along in the session (/api/auth/me, login). Synthetic identities only.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const bcrypt = require('bcrypt');
const request = require('supertest');
const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient');

const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const PARENT_ID = '550e8400-e29b-41d4-a716-446655440003';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const STUDENT_USER_ID = '550e8400-e29b-41d4-a716-446655440010';

const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'teacher@example.com', role: 'TEACHER' };
const asParent = { userId: PARENT_ID, username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };
const asStudent = {
  userId: STUDENT_USER_ID, username: 'Amal Haddad', email: 'amal.haddad@example.com', role: 'STUDENT', roles: ['STUDENT'],
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const pngOfSize = (bytes) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, bytes - PNG.length))]);
const photo = (as, buf = PNG, opts = { filename: 'me.png', contentType: 'image/png' }) =>
  authenticatedRequest('post', '/api/profile/photo', as).attach('photo', buf, opts);

describe('Integration: profile (avatar and photo)', () => {
  let pool;
  const spec = { style: 'kufi', skin: 1, bg: 4 };

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role, password = 'hashed') => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, $4, $5, $6, 'ALHAADIACADEMY', $7, true, true)`,
    [id, email, `${first} ${last}`, password, first, last, role],
  );
  const dbUser = async (id) => (await pool.query(`SELECT avatar, photo_path FROM users WHERE user_id = $1`, [id])).rows[0];
  const studentPhotos = (on) => pool.query(
    `INSERT INTO school_classroom_settings (school, enabled, student_photos) VALUES ('ALHAADIACADEMY', TRUE, $1)
     ON CONFLICT (school) DO UPDATE SET student_photos = EXCLUDED.student_photos`,
    [on],
  );
  const storage = () => supabase._mockStorage;

  beforeEach(async () => {
    supabase._reset();
    await user(ADMIN_ID, 'office@example.com', 'Office', 'Admin', 'ADMIN');
    await user(TEACHER_ID, 'teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(PARENT_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    await user(STUDENT_USER_ID, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT');
  });

  describe('avatar', () => {
    it('starts neutral', async () => {
      const res = await authenticatedRequest('get', '/api/profile', asTeacher);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ avatar: null, photoUrl: null, photosAllowed: true });
    });

    it('PUT stores the avatar and /api/auth/me returns it', async () => {
      const put = await authenticatedRequest('put', '/api/profile/avatar', asTeacher).send({ avatar: spec });
      expect(put.status).toBe(200);
      expect(put.body.data).toEqual({ avatar: spec });
      expect((await dbUser(TEACHER_ID)).avatar).toEqual(spec);

      const me = await authenticatedRequest('get', '/api/auth/me', asTeacher);
      expect(me.status).toBe(200);
      expect(me.body.data.avatar).toEqual(spec);
      expect(me.body.data.photoUrl).toBeNull();

      const profile = await authenticatedRequest('get', '/api/profile', asTeacher);
      expect(profile.body.data.avatar).toEqual(spec);
    });

    it('drops extra keys, and null goes back to neutral', async () => {
      const put = await authenticatedRequest('put', '/api/profile/avatar', asTeacher).send({ avatar: { ...spec, hair: 'red' } });
      expect(put.body.data.avatar).toEqual(spec);
      const cleared = await authenticatedRequest('put', '/api/profile/avatar', asTeacher).send({ avatar: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data).toEqual({ avatar: null });
      expect((await dbUser(TEACHER_ID)).avatar).toBeNull();
    });

    it('login returns the avatar too', async () => {
      const hash = await bcrypt.hash('correct horse', 10);
      await pool.query(`UPDATE users SET password = $2, avatar = $3::jsonb WHERE user_id = $1`, [TEACHER_ID, hash, JSON.stringify(spec)]);
      const res = await request(getApp()).post('/api/auth/login').send({ email: 'teacher@example.com', password: 'correct horse' });
      expect(res.status).toBe(200);
      expect(res.body.data.avatar).toEqual(spec);
      expect(res.body.data.photoUrl).toBeNull();
    });

    it.each([
      ['an unknown style', { avatar: { style: 'mohawk', skin: 0, bg: 0 } }],
      ['skin 6', { avatar: { style: 'short', skin: 6, bg: 0 } }],
      ['background 8', { avatar: { style: 'short', skin: 0, bg: 8 } }],
      ['a string', { avatar: 'short' }],
      ['no avatar key', {}],
    ])('rejects %s with 400 and stores nothing', async (_label, body) => {
      const res = await authenticatedRequest('put', '/api/profile/avatar', asTeacher).send(body);
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
      expect((await dbUser(TEACHER_ID)).avatar).toBeNull();
    });

    it('works for a parent', async () => {
      const res = await authenticatedRequest('put', '/api/profile/avatar', asParent).send({ avatar: spec });
      expect(res.status).toBe(200);
      expect((await dbUser(PARENT_ID)).avatar).toEqual(spec);
    });

    it('works for a student token (the fence lets /api/profile through) and only writes their own row', async () => {
      const res = await authenticatedRequest('put', '/api/profile/avatar', asStudent).send({ avatar: spec });
      expect(res.status).toBe(200);
      expect((await dbUser(STUDENT_USER_ID)).avatar).toEqual(spec);
      expect((await dbUser(TEACHER_ID)).avatar).toBeNull();
    });

    it('an admin "view as" preview cannot change the person\'s avatar', async () => {
      const preview = { ...asTeacher, impersonator: { userId: ADMIN_ID, username: 'Office Admin', fullName: 'Office Admin' } };
      const res = await authenticatedRequest('put', '/api/profile/avatar', preview).send({ avatar: spec });
      expect(res.status).toBe(403);
      expect((await dbUser(TEACHER_ID)).avatar).toBeNull();
    });

    it('401s without a token', async () => {
      const res = await request(getApp()).put('/api/profile/avatar').send({ avatar: spec });
      expect(res.status).toBe(401);
    });
  });

  describe('photo', () => {
    it('a teacher uploads: private avatars bucket, <SCHOOL>/<userId>/<uuid>.png, signed URL back', async () => {
      const res = await photo(asTeacher);

      expect(res.status).toBe(200);
      const { photo_path: path } = await dbUser(TEACHER_ID);
      expect(path).toMatch(new RegExp(`^ALHAADIACADEMY/${TEACHER_ID}/[0-9a-f-]{36}\\.png$`));
      expect(supabase.storage.from).toHaveBeenCalledWith('avatars');
      const [uploadedPath, body, options] = storage().upload.mock.calls[0];
      expect(uploadedPath).toBe(path);
      expect(Buffer.compare(body, PNG)).toBe(0);
      expect(options).toMatchObject({ contentType: 'image/png' });
      expect(storage().createSignedUrl).toHaveBeenCalledWith(path, expect.any(Number));
      expect(res.body.data).toEqual({ photoUrl: 'https://mock-signed-url.com' });
    });

    it('GET /api/profile and /api/auth/me return the signed URL', async () => {
      await photo(asTeacher);
      const profile = await authenticatedRequest('get', '/api/profile', asTeacher);
      expect(profile.body.data).toMatchObject({ photoUrl: 'https://mock-signed-url.com', photosAllowed: true });
      const me = await authenticatedRequest('get', '/api/auth/me', asTeacher);
      expect(me.body.data.photoUrl).toBe('https://mock-signed-url.com');
    });

    it('a new photo replaces and removes the old file', async () => {
      await photo(asTeacher);
      const first = (await dbUser(TEACHER_ID)).photo_path;
      await photo(asTeacher);
      const second = (await dbUser(TEACHER_ID)).photo_path;
      expect(second).not.toBe(first);
      expect(storage().remove).toHaveBeenCalledWith([first]);
    });

    it('DELETE clears the photo and removes the file', async () => {
      await photo(asTeacher);
      const path = (await dbUser(TEACHER_ID)).photo_path;

      const res = await authenticatedRequest('delete', '/api/profile/photo', asTeacher);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ photoUrl: null });
      expect((await dbUser(TEACHER_ID)).photo_path).toBeNull();
      expect(storage().remove).toHaveBeenCalledWith([path]);
    });

    it('DELETE with no photo is fine', async () => {
      const res = await authenticatedRequest('delete', '/api/profile/photo', asTeacher);
      expect(res.status).toBe(200);
      expect(storage().remove).not.toHaveBeenCalled();
    });

    it('rejects a wrong type, a disguised file, no file and a file over 2 MB', async () => {
      const gif = await photo(asTeacher, Buffer.from('GIF89a'), { filename: 'me.gif', contentType: 'image/gif' });
      expect(gif.status).toBe(400);
      const disguised = await photo(asTeacher, Buffer.from('not an image, just words'), { filename: 'me.png', contentType: 'image/png' });
      expect(disguised.status).toBe(400);
      const none = await authenticatedRequest('post', '/api/profile/photo', asTeacher).send({});
      expect(none.status).toBe(400);
      const big = await photo(asTeacher, pngOfSize(2 * 1024 * 1024 + 1));
      expect(big.status).toBe(400);
      expect(big.body.message).toMatch(/2 MB/);
      expect(storage().upload).not.toHaveBeenCalled();
      expect((await dbUser(TEACHER_ID)).photo_path).toBeNull();
    });

    it('keeps the profile unchanged and answers 500 when storage fails', async () => {
      storage().upload.mockResolvedValueOnce({ data: null, error: { message: 'bucket down' } });
      const res = await photo(asTeacher);
      expect(res.status).toBe(500);
      expect((await dbUser(TEACHER_ID)).photo_path).toBeNull();
    });

    it('an admin "view as" preview cannot upload or remove a photo', async () => {
      const preview = { ...asTeacher, impersonator: { userId: ADMIN_ID, username: 'Office Admin', fullName: 'Office Admin' } };
      const up = await photo(preview);
      expect(up.status).toBe(403);
      const del = await authenticatedRequest('delete', '/api/profile/photo', preview);
      expect(del.status).toBe(403);
    });
  });

  describe('student photos', () => {
    it('are refused with 403 while the school setting is off (and with no setting row at all)', async () => {
      const none = await photo(asStudent);
      expect(none.status).toBe(403);
      expect(none.body.message).toBe('Photos are turned off for students at your school');

      await studentPhotos(false);
      const off = await photo(asStudent);
      expect(off.status).toBe(403);
      expect(storage().upload).not.toHaveBeenCalled();
      expect((await dbUser(STUDENT_USER_ID)).photo_path).toBeNull();

      const profile = await authenticatedRequest('get', '/api/profile', asStudent);
      expect(profile.body.data).toEqual({ avatar: null, photoUrl: null, photosAllowed: false });
    });

    it('are accepted when the school turns them on, and DELETE clears them', async () => {
      await studentPhotos(true);

      const res = await photo(asStudent);
      expect(res.status).toBe(200);
      expect(res.body.data.photoUrl).toBe('https://mock-signed-url.com');
      expect((await dbUser(STUDENT_USER_ID)).photo_path).toMatch(new RegExp(`^ALHAADIACADEMY/${STUDENT_USER_ID}/`));
      const profile = await authenticatedRequest('get', '/api/profile', asStudent);
      expect(profile.body.data).toMatchObject({ photosAllowed: true, photoUrl: 'https://mock-signed-url.com' });

      const del = await authenticatedRequest('delete', '/api/profile/photo', asStudent);
      expect(del.status).toBe(200);
      expect((await dbUser(STUDENT_USER_ID)).photo_path).toBeNull();
    });

    it('stop showing when the school turns the setting off again, but the file stays for when it returns', async () => {
      await studentPhotos(true);
      await photo(asStudent);
      await studentPhotos(false);

      const profile = await authenticatedRequest('get', '/api/profile', asStudent);
      expect(profile.body.data).toEqual({ avatar: null, photoUrl: null, photosAllowed: false });
      expect((await dbUser(STUDENT_USER_ID)).photo_path).not.toBeNull();
    });

    it('do not limit adults: teachers and parents upload whatever the student setting says', async () => {
      await studentPhotos(false);
      expect((await photo(asTeacher)).status).toBe(200);
      expect((await photo(asParent)).status).toBe(200);
    });
  });

  describe('avatars in other payloads', () => {
    let yearId, studentId, classId;

    beforeEach(async () => {
      yearId = (await pool.query(
        `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
      )).rows[0].school_year_id;
      studentId = (await pool.query(
        `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id)
         VALUES ('Amal Haddad', '2', 'ALHAADIACADEMY', $1, $2) RETURNING student_id`,
        [yearId, TEACHER_ID],
      )).rows[0].student_id;
      classId = (await pool.query(
        `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_name, school_year_id)
         VALUES ('ALHAADIACADEMY', '2', 'Math', 'Ziad Teacher', $1, 'Term 1', $2) RETURNING class_id`,
        [TEACHER_ID, yearId],
      )).rows[0].class_id;
      await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, studentId]);
      await pool.query(
        `INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school)
         VALUES ($1, $2, 'Mona Haddad', 'mona.haddad@example.com', 'Mother', 'ALHAADIACADEMY')`,
        [studentId, PARENT_ID],
      );
    });

    const childOf = async () => {
      const res = await authenticatedRequest('get', `/api/parent-students/parent/${PARENT_ID}`, asParent);
      expect(res.status).toBe(200);
      return res.body.data.find((r) => r.studentId === studentId).student;
    };

    it("a parent's child list carries the child's avatar: teacher-set until the child's login picks its own", async () => {
      expect((await childOf()).avatar).toBeNull();

      const teacherSet = { style: 'short', skin: 0, bg: 0 };
      await authenticatedRequest('put', `/api/classroom/classes/${classId}/students/${studentId}/avatar`, asTeacher).send({ avatar: teacherSet });
      expect((await childOf()).avatar).toEqual(teacherSet);

      await pool.query(`INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [STUDENT_USER_ID, studentId, yearId]);
      expect((await childOf()).avatar).toEqual(teacherSet); // login has no pick yet

      const own = { style: 'long', skin: 4, bg: 7 };
      await authenticatedRequest('put', '/api/profile/avatar', asStudent).send({ avatar: own });
      expect((await childOf()).avatar).toEqual(own);
    });

    it('GET /api/student/me returns the signed-in student\'s own avatar and photo URL', async () => {
      await pool.query(`INSERT INTO school_classroom_settings (school, enabled, student_photos) VALUES ('ALHAADIACADEMY', TRUE, TRUE)`);
      await pool.query(`INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [STUDENT_USER_ID, studentId, yearId]);
      // Consent on file: requireStudent re-checks the sign-in gate on every request (Fable M6).
      await pool.query(`INSERT INTO student_accounts (user_id, school, consent_at) VALUES ($1, 'ALHAADIACADEMY', NOW())
                        ON CONFLICT (user_id) DO UPDATE SET consent_at = NOW()`, [STUDENT_USER_ID]);

      const before = await authenticatedRequest('get', '/api/student/me', asStudent);
      expect(before.status).toBe(200);
      expect(before.body.data.user).toMatchObject({ userId: STUDENT_USER_ID, avatar: null, photoUrl: null });

      const own = { style: 'hijab', skin: 1, bg: 2 };
      await authenticatedRequest('put', '/api/profile/avatar', asStudent).send({ avatar: own });
      await photo(asStudent);

      const after = await authenticatedRequest('get', '/api/student/me', asStudent);
      expect(after.body.data.user).toMatchObject({ avatar: own, photoUrl: 'https://mock-signed-url.com' });

      await pool.query(`UPDATE school_classroom_settings SET student_photos = FALSE WHERE school = 'ALHAADIACADEMY'`);
      const off = await authenticatedRequest('get', '/api/student/me', asStudent);
      expect(off.body.data.user.photoUrl).toBeNull();
      expect(off.body.data.user.avatar).toEqual(own);
    });
  });
});
