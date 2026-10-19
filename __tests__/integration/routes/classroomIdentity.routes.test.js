// Class identity (banner, icon, color), class options, archive, and the
// teacher-set avatar of a student without a login. Synthetic identities only.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440002';
const PARENT_ID = '550e8400-e29b-41d4-a716-446655440003';
const STUDENT_USER_ID = '550e8400-e29b-41d4-a716-446655440010';

const asAdmin = { userId: ADMIN_ID, username: 'Office Admin', email: 'office@example.com', role: 'ADMIN' };
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'teacher@example.com', role: 'TEACHER' };
const asOtherTeacher = { userId: OTHER_TEACHER_ID, username: 'Dina Teacher', email: 'dina.teacher@example.com', role: 'TEACHER' };
const asParent = { userId: PARENT_ID, username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };
const asStudent = {
  userId: STUDENT_USER_ID, username: 'Amal Haddad', email: 'amal.haddad@example.com', role: 'STUDENT', roles: ['STUDENT'],
};

// A real 1x1 PNG, so the magic-byte check passes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const pngOfSize = (bytes) => Buffer.concat([PNG, Buffer.alloc(Math.max(0, bytes - PNG.length))]);

const BASE = '/api/classroom/classes';

describe('Integration: class identity, options, archive, student avatar', () => {
  let pool, yearId, classId, studentId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, 'ALHAADIACADEMY', $6, true, true)`,
    [id, email, `${first} ${last}`, first, last, role],
  );
  const makeClass = async (subject, grade = '5', teacherId = TEACHER_ID) => (await pool.query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_name, school_year_id)
     VALUES ('ALHAADIACADEMY', $1, $2, 'Ziad Teacher', $3, 'Term 1', $4) RETURNING class_id`,
    [grade, subject, teacherId, yearId],
  )).rows[0].class_id;
  const row = async (id = classId) => (await pool.query(`SELECT * FROM classes WHERE class_id = $1`, [id])).rows[0];
  const storage = () => supabase._mockStorage;

  beforeEach(async () => {
    supabase._reset();
    storage().getPublicUrl.mockImplementation((p) => ({ data: { publicUrl: `https://cdn.example.com/school-assets/${p}` } }));
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    await user(ADMIN_ID, 'office@example.com', 'Office', 'Admin', 'ADMIN');
    await user(TEACHER_ID, 'teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(OTHER_TEACHER_ID, 'dina.teacher@example.com', 'Dina', 'Teacher', 'TEACHER');
    await user(PARENT_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    classId = await makeClass('Science');
    studentId = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id)
       VALUES ('Lina Haddad', '5', 'ALHAADIACADEMY', $1, $2) RETURNING student_id`,
      [yearId, TEACHER_ID],
    )).rows[0].student_id;
    await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, studentId]);
  });

  describe('PATCH /identity', () => {
    it('stores the picks and returns the resolved identity (owner)', async () => {
      const res = await authenticatedRequest('patch', `${BASE}/${classId}/identity`, asTeacher)
        .send({ bannerKey: 'math', iconKey: 'art', color: 'rose' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.classId).toBe(classId);
      expect(res.body.data.identity).toEqual({
        family: 'science', bannerKey: 'math', bannerIsUpload: false, bannerUrl: '/class-banners/math.svg',
        iconKey: 'art', iconUrl: '/class-icons/art.svg', color: 'rose',
        isDefault: { banner: false, icon: false, color: false },
      });
      expect(await row()).toMatchObject({ banner_key: 'math', banner_path: null, icon_key: 'art', color: 'rose' });
    });

    it('leaves fields that are not in the request alone, and null sends one back to the default', async () => {
      await authenticatedRequest('patch', `${BASE}/${classId}/identity`, asTeacher)
        .send({ bannerKey: 'math', iconKey: 'art', color: 'rose' });

      const res = await authenticatedRequest('patch', `${BASE}/${classId}/identity`, asTeacher).send({ color: null });

      expect(res.status).toBe(200);
      expect(res.body.data.identity).toMatchObject({
        bannerKey: 'math', iconKey: 'art', color: 'teal', isDefault: { banner: false, icon: false, color: true },
      });
      expect(await row()).toMatchObject({ banner_key: 'math', icon_key: 'art', color: null });
    });

    it('choosing a library banner drops an uploaded one and removes the file', async () => {
      await pool.query(`UPDATE classes SET banner_path = 'ALHAADIACADEMY/class-banners/x/old.png' WHERE class_id = $1`, [classId]);

      const res = await authenticatedRequest('patch', `${BASE}/${classId}/identity`, asTeacher).send({ bannerKey: 'art' });

      expect(res.status).toBe(200);
      expect(res.body.data.identity).toMatchObject({ bannerKey: 'art', bannerIsUpload: false });
      expect((await row()).banner_path).toBeNull();
      expect(supabase.storage.from).toHaveBeenCalledWith('school-assets');
      expect(storage().remove).toHaveBeenCalledWith(['ALHAADIACADEMY/class-banners/x/old.png']);
    });

    it('lets an admin change any class of the school', async () => {
      const res = await authenticatedRequest('patch', `${BASE}/${classId}/identity`, asAdmin).send({ color: 'purple' });
      expect(res.status).toBe(200);
      expect((await row()).color).toBe('purple');
    });

    it("refuses another teacher, a parent and a student, and changes nothing", async () => {
      const other = await authenticatedRequest('patch', `${BASE}/${classId}/identity`, asOtherTeacher).send({ color: 'pink' });
      expect(other.status).toBe(403);
      const parent = await authenticatedRequest('patch', `${BASE}/${classId}/identity`, asParent).send({ color: 'pink' });
      expect(parent.status).toBe(403);
      const student = await authenticatedRequest('patch', `${BASE}/${classId}/identity`, asStudent).send({ color: 'pink' });
      expect(student.status).toBe(403);
      expect(student.body.code).toBe('STUDENT_FORBIDDEN');
      expect((await row()).color).toBeNull();
    });

    it.each([
      ['an unknown banner', { bannerKey: 'mohawk' }],
      ['an unknown icon', { iconKey: 'rocket' }],
      ['an unknown color', { color: 'chartreuse' }],
      ['a non-string key', { bannerKey: 7 }],
      ['an empty body', {}],
      ['only unknown fields', { size: 'large' }],
    ])('rejects %s with 400', async (_label, body) => {
      const res = await authenticatedRequest('patch', `${BASE}/${classId}/identity`, asTeacher).send(body);
      expect(res.status).toBe(400);
      expect(res.body.status).toBe('failed');
      expect(await row()).toMatchObject({ banner_key: null, icon_key: null, color: null });
    });

    it('404s for a class that does not exist', async () => {
      const res = await authenticatedRequest('patch', `${BASE}/550e8400-e29b-41d4-a716-4466554400ff/identity`, asAdmin).send({ color: 'pink' });
      expect(res.status).toBe(404);
    });
  });

  describe('banner upload', () => {
    const upload = (as, id = classId, buf = PNG, opts = { filename: 'banner.png', contentType: 'image/png' }) =>
      authenticatedRequest('post', `${BASE}/${id}/banner`, as).attach('banner', buf, opts);

    it('stores the file in school-assets and reports the upload', async () => {
      const res = await upload(asTeacher);

      expect(res.status).toBe(200);
      const { banner_path: path } = await row();
      expect(path).toMatch(new RegExp(`^ALHAADIACADEMY/class-banners/${classId}/[0-9a-f-]{36}\\.png$`));
      expect(supabase.storage.from).toHaveBeenCalledWith('school-assets');
      expect(storage().upload).toHaveBeenCalledTimes(1);
      const [uploadedPath, body, options] = storage().upload.mock.calls[0];
      expect(uploadedPath).toBe(path);
      expect(Buffer.compare(body, PNG)).toBe(0);
      expect(options).toMatchObject({ contentType: 'image/png' });
      expect(res.body.data.identity).toMatchObject({
        bannerIsUpload: true, bannerKey: null, bannerUrl: `https://cdn.example.com/school-assets/${path}`,
        isDefault: { banner: false },
      });
    });

    it('replaces a library pick, and removes the previous upload when a new one arrives', async () => {
      await pool.query(`UPDATE classes SET banner_key = 'math' WHERE class_id = $1`, [classId]);
      await upload(asTeacher);
      const first = (await row()).banner_path;
      expect((await row()).banner_key).toBeNull();
      expect(storage().remove).not.toHaveBeenCalled();

      await upload(asTeacher);

      const second = (await row()).banner_path;
      expect(second).not.toBe(first);
      expect(storage().remove).toHaveBeenCalledWith([first]);
    });

    it('does not delete an upload that another class (a duplicate) still uses', async () => {
      await upload(asTeacher);
      const path = (await row()).banner_path;
      const copy = await makeClass('Science');
      await pool.query(`UPDATE classes SET banner_path = $2 WHERE class_id = $1`, [copy, path]);

      const res = await authenticatedRequest('post', `${BASE}/${classId}/identity/reset`, asTeacher);

      expect(res.status).toBe(200);
      expect(storage().remove).not.toHaveBeenCalled();
      expect((await row(copy)).banner_path).toBe(path);
    });

    it('stores a JPEG and a WebP under their own extensions', async () => {
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
      const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]);
      const j = await upload(asTeacher, classId, jpeg, { filename: 'b.jpeg', contentType: 'image/jpeg' });
      expect(j.status).toBe(200);
      expect((await row()).banner_path).toMatch(/\.jpg$/);
      const w = await upload(asTeacher, classId, webp, { filename: 'b.webp', contentType: 'image/webp' });
      expect(w.status).toBe(200);
      expect((await row()).banner_path).toMatch(/\.webp$/);
    });

    it('rejects a wrong type, a disguised file, no file and a file over 3 MB', async () => {
      const gif = await upload(asTeacher, classId, Buffer.from('GIF89a'), { filename: 'b.gif', contentType: 'image/gif' });
      expect(gif.status).toBe(400);
      const disguised = await upload(asTeacher, classId, Buffer.from('this is not an image at all'), { filename: 'b.png', contentType: 'image/png' });
      expect(disguised.status).toBe(400);
      const none = await authenticatedRequest('post', `${BASE}/${classId}/banner`, asTeacher).send({});
      expect(none.status).toBe(400);
      const big = await upload(asTeacher, classId, pngOfSize(3 * 1024 * 1024 + 1));
      expect(big.status).toBe(400);
      expect(big.body.message).toMatch(/3 MB/);
      const ok = await upload(asTeacher, classId, pngOfSize(3 * 1024 * 1024));
      expect(ok.status).toBe(200);
      expect(storage().upload).toHaveBeenCalledTimes(1);
    });

    it("refuses another teacher and leaves the row alone", async () => {
      const res = await upload(asOtherTeacher);
      expect(res.status).toBe(403);
      expect(storage().upload).not.toHaveBeenCalled();
      expect((await row()).banner_path).toBeNull();
    });

    it('keeps the row unchanged and answers 500 when storage fails', async () => {
      storage().upload.mockResolvedValueOnce({ data: null, error: { message: 'bucket down' } });
      const res = await upload(asTeacher);
      expect(res.status).toBe(500);
      expect((await row()).banner_path).toBeNull();
    });
  });

  describe('DELETE /banner and POST /identity/reset', () => {
    it('DELETE banner returns to the family banner and removes the upload', async () => {
      await authenticatedRequest('post', `${BASE}/${classId}/banner`, asTeacher)
        .attach('banner', PNG, { filename: 'b.png', contentType: 'image/png' });
      const path = (await row()).banner_path;

      const res = await authenticatedRequest('delete', `${BASE}/${classId}/banner`, asTeacher);

      expect(res.status).toBe(200);
      expect(res.body.data.identity).toMatchObject({
        bannerIsUpload: false, bannerKey: 'science', bannerUrl: '/class-banners/science.svg', isDefault: { banner: true },
      });
      expect(await row()).toMatchObject({ banner_path: null, banner_key: null });
      expect(storage().remove).toHaveBeenCalledWith([path]);
    });

    it('DELETE banner also clears a library pick', async () => {
      await pool.query(`UPDATE classes SET banner_key = 'art' WHERE class_id = $1`, [classId]);
      const res = await authenticatedRequest('delete', `${BASE}/${classId}/banner`, asTeacher);
      expect(res.status).toBe(200);
      expect(res.body.data.identity.bannerKey).toBe('science');
      expect((await row()).banner_key).toBeNull();
    });

    it('reset clears all four fields and removes the upload', async () => {
      await pool.query(
        `UPDATE classes SET banner_key = 'math', icon_key = 'art', color = 'rose', banner_path = 'ALHAADIACADEMY/class-banners/x/b.png' WHERE class_id = $1`,
        [classId],
      );

      const res = await authenticatedRequest('post', `${BASE}/${classId}/identity/reset`, asTeacher);

      expect(res.status).toBe(200);
      expect(res.body.data.identity).toMatchObject({
        family: 'science', bannerKey: 'science', iconKey: 'science', color: 'teal',
        isDefault: { banner: true, icon: true, color: true },
      });
      expect(await row()).toMatchObject({ banner_key: null, banner_path: null, icon_key: null, color: null });
      expect(storage().remove).toHaveBeenCalledWith(['ALHAADIACADEMY/class-banners/x/b.png']);
    });

    it('refuses another teacher', async () => {
      expect((await authenticatedRequest('delete', `${BASE}/${classId}/banner`, asOtherTeacher)).status).toBe(403);
      expect((await authenticatedRequest('post', `${BASE}/${classId}/identity/reset`, asOtherTeacher)).status).toBe(403);
    });
  });

  describe('PATCH /options', () => {
    it('stores the options and returns all three', async () => {
      const res = await authenticatedRequest('patch', `${BASE}/${classId}/options`, asTeacher)
        .send({ acceptLate: false, showClassAverage: true });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        classId, options: { acceptLate: false, emailNewPosts: true, showClassAverage: true },
      });
      expect(await row()).toMatchObject({ accept_late: false, email_new_posts: true, show_class_average: true });
    });

    it('changes only what is sent', async () => {
      await authenticatedRequest('patch', `${BASE}/${classId}/options`, asTeacher).send({ acceptLate: false });
      const res = await authenticatedRequest('patch', `${BASE}/${classId}/options`, asTeacher).send({ emailNewPosts: false });
      expect(res.body.data.options).toEqual({ acceptLate: false, emailNewPosts: false, showClassAverage: false });
    });

    it.each([
      ['a non-boolean', { acceptLate: 'no' }],
      ['an empty body', {}],
      ['unknown fields only', { archive: true }],
    ])('rejects %s with 400', async (_label, body) => {
      const res = await authenticatedRequest('patch', `${BASE}/${classId}/options`, asTeacher).send(body);
      expect(res.status).toBe(400);
    });

    it('refuses another teacher', async () => {
      const res = await authenticatedRequest('patch', `${BASE}/${classId}/options`, asOtherTeacher).send({ acceptLate: false });
      expect(res.status).toBe(403);
      expect((await row()).accept_late).toBe(true);
    });
  });

  describe('archive and unarchive', () => {
    it('archives with the time and the person, and unarchives', async () => {
      const res = await authenticatedRequest('post', `${BASE}/${classId}/archive`, asTeacher);
      expect(res.status).toBe(200);
      expect(res.body.data.classId).toBe(classId);
      expect(new Date(res.body.data.archivedAt).getTime()).not.toBeNaN();
      expect(await row()).toMatchObject({ archived_by: TEACHER_ID });
      expect((await row()).archived_at).toBeInstanceOf(Date);

      const back = await authenticatedRequest('post', `${BASE}/${classId}/unarchive`, asTeacher);
      expect(back.status).toBe(200);
      expect(back.body.data).toEqual({ classId, archivedAt: null });
      expect(await row()).toMatchObject({ archived_at: null, archived_by: null });
    });

    it('keeps the first archive time when archived twice', async () => {
      const first = await authenticatedRequest('post', `${BASE}/${classId}/archive`, asTeacher);
      const second = await authenticatedRequest('post', `${BASE}/${classId}/archive`, asAdmin);
      expect(second.body.data.archivedAt).toBe(first.body.data.archivedAt);
      expect((await row()).archived_by).toBe(TEACHER_ID);
    });

    it('refuses another teacher and a student', async () => {
      expect((await authenticatedRequest('post', `${BASE}/${classId}/archive`, asOtherTeacher)).status).toBe(403);
      expect((await authenticatedRequest('post', `${BASE}/${classId}/archive`, asStudent)).status).toBe(403);
      expect((await row()).archived_at).toBeNull();
    });

    it('shows archivedAt on GET /api/classes/:id', async () => {
      await authenticatedRequest('post', `${BASE}/${classId}/archive`, asTeacher);
      const res = await authenticatedRequest('get', `/api/classes/${classId}`, asTeacher);
      expect(res.body.data.archivedAt).not.toBeNull();
    });
  });

  describe('PUT /students/:studentId/avatar', () => {
    const spec = { style: 'hijab', skin: 2, bg: 3 };

    it("stores an enrolled student's avatar", async () => {
      const res = await authenticatedRequest('put', `${BASE}/${classId}/students/${studentId}/avatar`, asTeacher).send({ avatar: spec });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ studentId, avatar: spec });
      expect((await pool.query(`SELECT avatar FROM students WHERE student_id = $1`, [studentId])).rows[0].avatar).toEqual(spec);
    });

    it('drops extra keys and null clears the avatar', async () => {
      const res = await authenticatedRequest('put', `${BASE}/${classId}/students/${studentId}/avatar`, asTeacher)
        .send({ avatar: { ...spec, hair: 'red' } });
      expect(res.body.data.avatar).toEqual(spec);

      const cleared = await authenticatedRequest('put', `${BASE}/${classId}/students/${studentId}/avatar`, asTeacher).send({ avatar: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data).toEqual({ studentId, avatar: null });
      expect((await pool.query(`SELECT avatar FROM students WHERE student_id = $1`, [studentId])).rows[0].avatar).toBeNull();
    });

    it('404s for a student who is not in this class', async () => {
      const stranger = (await pool.query(
        `INSERT INTO students (name, grade, school, school_year_id) VALUES ('Sami Haddad', '5', 'ALHAADIACADEMY', $1) RETURNING student_id`,
        [yearId],
      )).rows[0].student_id;
      const res = await authenticatedRequest('put', `${BASE}/${classId}/students/${stranger}/avatar`, asTeacher).send({ avatar: spec });
      expect(res.status).toBe(404);
      expect((await pool.query(`SELECT avatar FROM students WHERE student_id = $1`, [stranger])).rows[0].avatar).toBeNull();
    });

    it.each([
      ['an unknown style', { avatar: { style: 'mohawk', skin: 0, bg: 0 } }],
      ['skin 5', { avatar: { style: 'short', skin: 5, bg: 0 } }],
      ['no avatar key', {}],
    ])('rejects %s with 400', async (_label, body) => {
      const res = await authenticatedRequest('put', `${BASE}/${classId}/students/${studentId}/avatar`, asTeacher).send(body);
      expect(res.status).toBe(400);
    });

    it('T5: a malformed student id is a clean 404 (never a 500), on every per-student classroom route', async () => {
      const bad = 'not-a-uuid';
      const calls = [
        authenticatedRequest('put', `${BASE}/${classId}/students/${bad}/avatar`, asTeacher).send({ avatar: spec }),
        authenticatedRequest('post', `${BASE}/${classId}/students/${bad}/reset-password`, asTeacher),
        authenticatedRequest('post', `${BASE}/${classId}/students/${bad}/resend-invite`, asTeacher),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ status: 'failed', message: 'Student not found' });
      }
    });

    it("refuses a teacher who does not teach the class", async () => {
      const res = await authenticatedRequest('put', `${BASE}/${classId}/students/${studentId}/avatar`, asOtherTeacher).send({ avatar: spec });
      expect(res.status).toBe(403);
    });

    it("shows on GET /api/students as the student's avatar, with a linked login's pick winning", async () => {
      await authenticatedRequest('put', `${BASE}/${classId}/students/${studentId}/avatar`, asTeacher).send({ avatar: spec });
      let res = await authenticatedRequest('get', '/api/students', asAdmin);
      expect(res.body.data.find((s) => s.studentId === studentId).avatar).toEqual(spec);

      await user(STUDENT_USER_ID, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT');
      await pool.query(`INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [STUDENT_USER_ID, studentId, yearId]);
      res = await authenticatedRequest('get', '/api/students', asAdmin);
      expect(res.body.data.find((s) => s.studentId === studentId).avatar).toEqual(spec);

      const own = { style: 'curly', skin: 4, bg: 6 };
      await pool.query(`UPDATE users SET avatar = $2::jsonb WHERE user_id = $1`, [STUDENT_USER_ID, JSON.stringify(own)]);
      res = await authenticatedRequest('get', '/api/students', asAdmin);
      expect(res.body.data.find((s) => s.studentId === studentId).avatar).toEqual(own);
      const one = await authenticatedRequest('get', `/api/students/${studentId}`, asAdmin);
      expect(one.body.data.avatar).toEqual(own);
    });
  });

  describe('class payloads', () => {
    it('GET /api/classes/:id includes identity, options and archivedAt', async () => {
      const res = await authenticatedRequest('get', `/api/classes/${classId}`, asTeacher);

      expect(res.status).toBe(200);
      expect(res.body.data.identity).toEqual({
        family: 'science', bannerKey: 'science', bannerIsUpload: false, bannerUrl: '/class-banners/science.svg',
        iconKey: 'science', iconUrl: '/class-icons/science.svg', color: 'teal',
        isDefault: { banner: true, icon: true, color: true },
      });
      expect(res.body.data.options).toEqual({ acceptLate: true, emailNewPosts: true, showClassAverage: false });
      expect(res.body.data.archivedAt).toBeNull();
    });

    it('every class list carries them too, with stored picks resolved', async () => {
      await authenticatedRequest('patch', `${BASE}/${classId}/identity`, asTeacher).send({ color: 'purple' });
      await authenticatedRequest('patch', `${BASE}/${classId}/options`, asTeacher).send({ showClassAverage: true });
      const kg = await makeClass('Homeroom', 'SK');

      const lists = {
        school: await authenticatedRequest('get', '/api/classes', asAdmin),
        teacherId: await authenticatedRequest('get', `/api/classes/teacher/id/${TEACHER_ID}`, asTeacher),
        teacherName: await authenticatedRequest('get', '/api/classes/teacher/Ziad Teacher', asTeacher),
      };
      for (const [name, res] of Object.entries(lists)) {
        expect(res.status).toBe(200);
        const science = res.body.data.find((c) => c.classId === classId);
        expect({ name, color: science.identity.color }).toEqual({ name, color: 'purple' });
        expect(science.options.showClassAverage).toBe(true);
        expect(science).toHaveProperty('archivedAt', null);
        expect(res.body.data.find((c) => c.classId === kg).identity.family).toBe('kindergarten');
      }
      const byGrade = await authenticatedRequest('get', '/api/classes/grade/5', asAdmin);
      expect(byGrade.body.data.find((c) => c.classId === classId).identity.color).toBe('purple');
    });

    it('an uploaded banner shows as an upload in the class payload', async () => {
      await authenticatedRequest('post', `${BASE}/${classId}/banner`, asTeacher)
        .attach('banner', PNG, { filename: 'b.png', contentType: 'image/png' });
      const res = await authenticatedRequest('get', `/api/classes/${classId}`, asTeacher);
      expect(res.body.data.identity).toMatchObject({ bannerIsUpload: true, bannerKey: null });
      expect(res.body.data.identity.bannerUrl).toMatch(/^https:\/\/cdn\.example\.com\/school-assets\/ALHAADIACADEMY\/class-banners\//);
    });

    it('duplicating a class copies identity and options (not the archive)', async () => {
      await pool.query(
        `UPDATE classes SET banner_key = 'math', icon_key = 'art', color = 'rose', accept_late = FALSE,
                email_new_posts = FALSE, show_class_average = TRUE, archived_at = NOW() WHERE class_id = $1`,
        [classId],
      );
      const termId = (await pool.query(
        `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active)
         VALUES ('ALHAADIACADEMY', 'Term 2', '2026-01-05', '2026-03-31', '2025-2026', false) RETURNING term_id`,
      )).rows[0].term_id;

      const res = await authenticatedRequest('post', `/api/classes/${classId}/duplicate`, asAdmin).send({
        grade: '5', subject: 'Science', teacherName: 'Ziad Teacher', teacherId: TEACHER_ID, termId, termName: 'Term 2',
      });

      expect(res.status).toBe(201);
      const copyId = res.body.data.classId;
      expect(await row(copyId)).toMatchObject({
        banner_key: 'math', icon_key: 'art', color: 'rose', accept_late: false,
        email_new_posts: false, show_class_average: true, archived_at: null,
      });
      const got = await authenticatedRequest('get', `/api/classes/${copyId}`, asAdmin);
      expect(got.body.data.identity).toMatchObject({ bannerKey: 'math', iconKey: 'art', color: 'rose' });
    });
  });
});
