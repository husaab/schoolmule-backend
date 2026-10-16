// Classroom teacher read API: class cards, class header, People roster and the
// classroom settings. Synthetic identities only: every address is @example.com.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const CO_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440002';
const OTHER_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440003';
const MONA_ID = '550e8400-e29b-41d4-a716-446655440004';
const AMAL_USER_ID = '550e8400-e29b-41d4-a716-446655440010';
const SAMI_USER_ID = '550e8400-e29b-41d4-a716-446655440011';
const FOREIGN_ADMIN_ID = '550e8400-e29b-41d4-a716-446655440020';
const FOREIGN_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440021';

const asAdmin = { userId: ADMIN_ID, username: 'Office Admin', email: 'office@example.com', role: 'ADMIN' };
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'teacher@example.com', role: 'TEACHER' };
const asCoTeacher = { userId: CO_TEACHER_ID, username: 'Omar Coteacher', email: 'omar.coteacher@example.com', role: 'TEACHER' };
const asOtherTeacher = { userId: OTHER_TEACHER_ID, username: 'Dina Teacher', email: 'dina.teacher@example.com', role: 'TEACHER' };
const asParent = { userId: MONA_ID, username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };
const asForeignAdmin = {
  userId: FOREIGN_ADMIN_ID, username: 'Yard Admin', email: 'yard.admin@example.com', role: 'ADMIN', school: 'PLAYGROUND',
};
const asStudent = {
  userId: AMAL_USER_ID, username: 'Amal Haddad', email: 'amal.haddad@example.com', role: 'STUDENT', roles: ['STUDENT'],
};

const BASE = '/api/classroom';
const UNKNOWN_UUID = '99999999-9999-4999-8999-999999999999';

describe('Integration: classroom teacher read API', () => {
  let pool, yearId, pastYearId;
  let sciId, mathId, artId, archivedId, pastSciId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role, password = 'hashed') => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, $4, $5, $6, 'ALHAADIACADEMY', $7, true, true)`,
    [id, email, `${first} ${last}`, password, first, last, role],
  );
  const makeClass = async (subject, grade, teacherId, extra = {}) => (await pool.query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_name, school_year_id, archived_at)
     VALUES ('ALHAADIACADEMY', $1, $2, 'Lead Name', $3, 'Term 1', $4, $5) RETURNING class_id`,
    [grade, subject, teacherId, extra.yearId ?? yearId, extra.archivedAt ?? null],
  )).rows[0].class_id;
  const coTeach = (classId, teacherId) => pool.query(
    `INSERT INTO class_teachers (class_id, teacher_id) VALUES ($1, $2)`, [classId, teacherId],
  );
  const student = async (name, grade, extra = {}) => {
    const id = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id, is_archived)
       VALUES ($1, $2, 'ALHAADIACADEMY', $3, $4, $5) RETURNING student_id`,
      [name, grade, yearId, extra.homeroom ?? null, extra.archived ?? false],
    )).rows[0].student_id;
    if (extra.classId) await pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [extra.classId, id]);
    return id;
  };
  const link = (userId, studentId) => pool.query(
    `INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [userId, studentId, yearId],
  );
  // days is an offset from today in Toronto
  const assessment = async (classId, name, days, extra = {}) => (await pool.query(
    `INSERT INTO assessments (class_id, name, date, is_parent, sort_order)
     VALUES ($1, $2, (NOW() AT TIME ZONE 'America/Toronto')::date + $3::int, $4, $5) RETURNING assessment_id`,
    [classId, name, days, extra.isParent ?? false, extra.sortOrder ?? 0],
  )).rows[0].assessment_id;
  // The classwork item the insert trigger gave an assessment (T14).
  const itemOf = async (assessmentId) => (await pool.query(
    `SELECT item_id FROM classwork_items WHERE assessment_id = $1`, [assessmentId],
  )).rows[0]?.item_id ?? null;
  const torontoDate = async (days) => (await pool.query(
    `SELECT TO_CHAR((NOW() AT TIME ZONE 'America/Toronto')::date + $1::int, 'YYYY-MM-DD') AS d`, [days],
  )).rows[0].d;
  const parentLink = (studentId, extra) => pool.query(
    `INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school)
     VALUES ($1, $2, $3, $4, $5, 'ALHAADIACADEMY')`,
    [studentId, extra.parentId ?? null, extra.name ?? null, extra.email ?? null, extra.relation ?? null],
  );
  const get = async (url, who = asTeacher) => authenticatedRequest('get', url, who);
  const cards = async (query = '', who = asTeacher) => {
    const res = await get(`${BASE}/classes${query}`, who);
    expect(res.status).toBe(200);
    return res.body.data;
  };
  const people = async (classId, who = asTeacher) => {
    const res = await get(`${BASE}/classes/${classId}/people`, who);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  beforeEach(async () => {
    supabase._reset();
    supabase._mockStorage.getPublicUrl.mockImplementation((p) => ({ data: { publicUrl: `https://cdn.example.com/school-assets/${p}` } }));

    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    pastYearId = (await pool.query(
      `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
       SELECT school, school_id, '2024-2025', DATE '2024-09-01', DATE '2025-06-30', FALSE FROM school_years WHERE school_year_id = $1
       RETURNING school_year_id`,
      [yearId],
    )).rows[0].school_year_id;

    await user(ADMIN_ID, 'office@example.com', 'Office', 'Admin', 'ADMIN');
    await user(TEACHER_ID, 'teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(CO_TEACHER_ID, 'omar.coteacher@example.com', 'Omar', 'Coteacher', 'TEACHER');
    await user(OTHER_TEACHER_ID, 'dina.teacher@example.com', 'Dina', 'Teacher', 'TEACHER');
    await user(MONA_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');

    sciId = await makeClass('Science', '5', TEACHER_ID);
    await coTeach(sciId, CO_TEACHER_ID);
    mathId = await makeClass('Math', '4', OTHER_TEACHER_ID);
    await coTeach(mathId, TEACHER_ID);
    artId = await makeClass('Art', '6', OTHER_TEACHER_ID);
    archivedId = await makeClass('Quran', '3', TEACHER_ID, { archivedAt: new Date('2026-09-20T12:00:00Z') });
    pastSciId = await makeClass('Science', '5', TEACHER_ID, { yearId: pastYearId });
  });

  describe('GET /classes', () => {
    it('teacher sees only classes they lead or co-teach this year', async () => {
      const data = await cards();
      expect(data.classes.map((c) => c.classId).sort()).toEqual([sciId, mathId].sort());
      expect(data.toReview).toEqual([]);
      expect(data.draftsAndScheduled).toEqual([]);

      const co = await cards('', asCoTeacher);
      expect(co.classes.map((c) => c.classId)).toEqual([sciId]);

      const other = await cards('', asOtherTeacher);
      expect(other.classes.map((c) => c.classId).sort()).toEqual([mathId, artId].sort());
    });

    it('admin sees every class of the year', async () => {
      const data = await cards('', asAdmin);
      expect(data.classes.map((c) => c.classId).sort()).toEqual([sciId, mathId, artId].sort());
      // Not the past year's class, not the archived one.
      expect(data.classes.map((c) => c.classId)).not.toContain(pastSciId);
    });

    it('lists the requested year when the X-School-Year header names it', async () => {
      const res = await authenticatedRequest('get', `${BASE}/classes`, asTeacher).set('X-School-Year', pastYearId);
      expect(res.status).toBe(200);
      expect(res.body.data.classes.map((c) => c.classId)).toEqual([pastSciId]);
    });

    it('archived classes are hidden unless archived=1', async () => {
      const hidden = await cards();
      expect(hidden.classes.map((c) => c.classId)).not.toContain(archivedId);

      const shown = await cards('?archived=1');
      const row = shown.classes.find((c) => c.classId === archivedId);
      expect(row).toBeDefined();
      expect(row.archivedAt).toBe('2026-09-20T12:00:00.000Z');
      expect(shown.classes.map((c) => c.classId)).toEqual(expect.arrayContaining([sciId, mathId, archivedId]));
    });

    it('card carries identity defaults, student count, teachers lead-first with avatars, next dated assessment', async () => {
      await pool.query(`UPDATE users SET avatar = $2::jsonb WHERE user_id = $1`, [TEACHER_ID, JSON.stringify({ style: 'hijab', skin: 2, bg: 3 })]);
      await student('Amal Haddad', '5', { classId: sciId, homeroom: TEACHER_ID });
      await student('Sami Haddad', '5', { classId: sciId });
      await student('Withdrawn Student', '5', { classId: sciId, archived: true });
      await assessment(sciId, 'Last week quiz', -3);
      await assessment(sciId, 'Chapter 2 test', 5, { sortOrder: 2 });
      const chapter1 = await assessment(sciId, 'Chapter 1 test', 2, { sortOrder: 1 });
      await assessment(sciId, 'Unit total', 1, { isParent: true });

      const data = await cards();
      const card = data.classes.find((c) => c.classId === sciId);
      const nextDate = await torontoDate(2);

      expect(card).toMatchObject({
        classId: sciId, subject: 'Science', grade: '5', termId: null, termName: 'Term 1',
        teacherId: TEACHER_ID, teacherName: 'Lead Name', studentCount: 2, archivedAt: null, toReviewCount: 0,
      });
      expect(card.identity).toEqual({
        family: 'science', bannerKey: 'science', bannerIsUpload: false, bannerUrl: '/class-banners/science.svg',
        iconKey: 'science', iconUrl: '/class-icons/science.svg', color: 'teal',
        isDefault: { banner: true, icon: true, color: true },
      });
      expect(card.teachers).toEqual([
        { userId: TEACHER_ID, name: 'Ziad Teacher', role: 'lead', avatar: { style: 'hijab', skin: 2, bg: 3 } },
        { userId: CO_TEACHER_ID, name: 'Omar Coteacher', role: 'co', avatar: null },
      ]);
      expect(card.next).toEqual({
        itemId: await itemOf(chapter1), assessmentId: chapter1, title: 'Chapter 1 test', kind: 'assessment', dueAt: null, date: nextDate,
      });
    });

    it('a class with nothing coming up has next null, and cards sort by grade then subject', async () => {
      const data = await cards();
      const math = data.classes.find((c) => c.classId === mathId);
      expect(math.next).toBeNull();
      expect(math.teachers.map((t) => t.role)).toEqual(['lead', 'co']);
      expect(data.classes.map((c) => c.subject)).toEqual(['Math', 'Science']);
    });

    it('a class with no roster has a student count of zero', async () => {
      const data = await cards();
      expect(data.classes.find((c) => c.classId === sciId).studentCount).toBe(0);
    });

    it('cards list JK and SK first, then Grades 1 to 8, with the subject as the tiebreak', async () => {
      await makeClass('Math', '8', TEACHER_ID);
      await makeClass('Science', '1', TEACHER_ID);
      await makeClass('Math', '1', TEACHER_ID);
      await makeClass('Art', '1', TEACHER_ID);
      await makeClass('Play and Learn', 'SK', TEACHER_ID);
      await makeClass('Play and Learn', 'JK', TEACHER_ID);

      const data = await cards();
      expect(data.classes.map((c) => `${c.grade} ${c.subject}`)).toEqual([
        'JK Play and Learn', 'SK Play and Learn', '1 Art', '1 Math', '1 Science', '4 Math', '5 Science', '8 Math',
      ]);
    });

    it('comingUp puts JK and SK before Grades 1 to 8 when assessments fall on the same day', async () => {
      const grade8 = await makeClass('Math', '8', TEACHER_ID);
      const grade1 = await makeClass('Science', '1', TEACHER_ID);
      const sk = await makeClass('Play and Learn', 'SK', TEACHER_ID);
      const jk = await makeClass('Play and Learn', 'JK', TEACHER_ID);
      await assessment(grade8, 'Eighth', 1);
      await assessment(grade1, 'First', 1);
      await assessment(sk, 'Senior', 1);
      await assessment(jk, 'Junior', 1);

      const data = await cards();
      expect(data.comingUp.map((r) => r.classLabel)).toEqual([
        'JK Play and Learn', 'SK Play and Learn', 'Grade 1 Science', 'Grade 8 Math',
      ]);
    });

    it('comingUp lists assessments in the next 14 days across the teacher\'s classes', async () => {
      const today = await assessment(sciId, 'Today quiz', 0);
      const fractions = await assessment(mathId, 'Fractions test', 3);
      const edge = await assessment(sciId, 'Edge of window', 14);
      await assessment(sciId, 'Too far out', 15);
      await assessment(sciId, 'Yesterday', -1);
      await assessment(sciId, 'A category', 4, { isParent: true });
      await assessment(artId, 'Not mine', 2);
      await assessment(archivedId, 'In an archived class', 2);
      await assessment(pastSciId, 'Last year', 2);

      const data = await cards();
      expect(data.comingUp).toEqual([
        {
          itemId: await itemOf(today), assessmentId: today, classId: sciId, classLabel: 'Grade 5 Science', title: 'Today quiz',
          kind: 'assessment', date: await torontoDate(0), dueAt: null, inClass: true, stillToTurnIn: null,
        },
        {
          itemId: await itemOf(fractions), assessmentId: fractions, classId: mathId, classLabel: 'Grade 4 Math', title: 'Fractions test',
          kind: 'assessment', date: await torontoDate(3), dueAt: null, inClass: true, stillToTurnIn: null,
        },
        {
          itemId: await itemOf(edge), assessmentId: edge, classId: sciId, classLabel: 'Grade 5 Science', title: 'Edge of window',
          kind: 'assessment', date: await torontoDate(14), dueAt: null, inClass: true, stillToTurnIn: null,
        },
      ]);
    });

    it('comingUp is capped at eight rows, earliest first', async () => {
      for (let i = 0; i < 10; i += 1) await assessment(sciId, `Quiz ${i}`, i);
      const data = await cards();
      expect(data.comingUp).toHaveLength(8);
      expect(data.comingUp.map((r) => r.title)).toEqual(['Quiz 0', 'Quiz 1', 'Quiz 2', 'Quiz 3', 'Quiz 4', 'Quiz 5', 'Quiz 6', 'Quiz 7']);
    });

    it('admin comingUp spans every class of the year', async () => {
      await assessment(artId, 'Painting', 1);
      const data = await cards('', asAdmin);
      expect(data.comingUp.map((r) => r.title)).toEqual(['Painting']);
      expect(data.comingUp[0].classLabel).toBe('Grade 6 Art');
    });

    it('student token is refused with STUDENT_FORBIDDEN', async () => {
      const res = await get(`${BASE}/classes`, asStudent);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('STUDENT_FORBIDDEN');
    });
  });

  describe('GET /classes/:classId (header)', () => {
    it('carries the card, options, teachers with homeroom grade and photo, permissions and settings', async () => {
      await pool.query(`UPDATE users SET photo_path = 'ALHAADIACADEMY/t/photo.png' WHERE user_id = $1`, [TEACHER_ID]);
      await pool.query(`UPDATE classes SET accept_late = FALSE, show_class_average = TRUE WHERE class_id = $1`, [sciId]);
      await student('Amal Haddad', '5', { classId: sciId, homeroom: TEACHER_ID });
      await student('Sami Haddad', '5', { classId: sciId, homeroom: TEACHER_ID });
      await student('Rami Haddad', '4', { classId: sciId, homeroom: TEACHER_ID });
      await assessment(sciId, 'Chapter 1 test', 2);

      const res = await get(`${BASE}/classes/${sciId}`);
      expect(res.status).toBe(200);
      const { class: cls, teachers, permissions, settings } = res.body.data;

      expect(cls).toMatchObject({
        classId: sciId, subject: 'Science', grade: '5', studentCount: 3, toReviewCount: 0, archivedAt: null,
        options: { acceptLate: false, emailNewPosts: true, showClassAverage: true },
        next: { title: 'Chapter 1 test', kind: 'assessment' },
      });
      expect(cls.identity.family).toBe('science');
      expect(teachers).toEqual([
        {
          userId: TEACHER_ID, name: 'Ziad Teacher', role: 'lead', avatar: null,
          photoUrl: 'https://mock-signed-url.com', homeroomGrade: '5',
        },
        {
          userId: CO_TEACHER_ID, name: 'Omar Coteacher', role: 'co', avatar: null, photoUrl: null, homeroomGrade: null,
        },
      ]);
      expect(permissions).toEqual({ canEdit: true, canDelete: true, isAdmin: false });
      expect(settings).toEqual({ parentsReadPrivateComments: true, studentPhotos: false, enabled: false });
    });

    it('an admin and a co-teacher may edit and delete a current-year class', async () => {
      const admin = await get(`${BASE}/classes/${sciId}`, asAdmin);
      expect(admin.body.data.permissions).toEqual({ canEdit: true, canDelete: true, isAdmin: true });
      const co = await get(`${BASE}/classes/${sciId}`, asCoTeacher);
      expect(co.status).toBe(200);
      expect(co.body.data.permissions).toEqual({ canEdit: true, canDelete: true, isAdmin: false });
    });

    it('a past school year is read-only for teachers but not admins', async () => {
      const teacher = await get(`${BASE}/classes/${pastSciId}`);
      expect(teacher.status).toBe(200);
      expect(teacher.body.data.permissions).toEqual({ canEdit: false, canDelete: false, isAdmin: false });
      const admin = await get(`${BASE}/classes/${pastSciId}`, asAdmin);
      expect(admin.body.data.permissions).toEqual({ canEdit: true, canDelete: true, isAdmin: true });
    });

    it('opens an archived class by its id, showing archivedAt, so it can be unarchived', async () => {
      const res = await get(`${BASE}/classes/${archivedId}`);
      expect(res.status).toBe(200);
      expect(res.body.data.class.archivedAt).toBe('2026-09-20T12:00:00.000Z');
    });

    it('header 403 for a teacher of another class, 404 for an unknown class', async () => {
      const other = await get(`${BASE}/classes/${artId}`);
      expect(other.status).toBe(403);
      const missing = await get(`${BASE}/classes/${UNKNOWN_UUID}`);
      expect(missing.status).toBe(404);
      expect(missing.body.status).toBe('failed');
    });

    it('a class id that is not a UUID is a 404, not a 500', async () => {
      const header = await get(`${BASE}/classes/not-a-uuid`);
      expect(header.status).toBe(404);
      const roster = await get(`${BASE}/classes/not-a-uuid/people`);
      expect(roster.status).toBe(404);
    });

    it('student token is refused with STUDENT_FORBIDDEN', async () => {
      const res = await get(`${BASE}/classes/${sciId}`, asStudent);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('STUDENT_FORBIDDEN');
    });
  });

  describe('GET /classes/:classId/people', () => {
    let amalId, samiId, ramiId, linaId;

    beforeEach(async () => {
      await user(AMAL_USER_ID, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT', '$2b$10$hashedpasswordvalue');
      await user(SAMI_USER_ID, 'sami.haddad@example.com', 'Sami', 'Haddad', 'STUDENT', '!');
      amalId = await student('Amal Haddad', '5', { classId: sciId, homeroom: TEACHER_ID });
      samiId = await student('Sami Haddad', '5', { classId: sciId });
      ramiId = await student('Rami Haddad', '5', { classId: sciId });
      linaId = await student('Lina Haddad', 'SK', { classId: sciId });
      await student('Withdrawn Student', '5', { classId: sciId, archived: true });
      await link(AMAL_USER_ID, amalId);
      await link(SAMI_USER_ID, samiId);
      await pool.query(`UPDATE users SET last_seen_at = $2 WHERE user_id = $1`, [AMAL_USER_ID, new Date('2026-10-14T15:00:00Z')]);
    });

    it('people statuses: not_invited, invited, active, not_eligible (SK)', async () => {
      const data = await people(sciId);
      const byId = Object.fromEntries(data.students.map((s) => [s.studentId, s]));

      expect(byId[amalId].account).toEqual({ status: 'active', userId: AMAL_USER_ID, lastSeenAt: '2026-10-14T15:00:00.000Z', qrEligible: false });
      expect(byId[samiId].account).toEqual({ status: 'invited', userId: SAMI_USER_ID, lastSeenAt: null, qrEligible: false });
      expect(byId[ramiId].account).toEqual({ status: 'not_invited', userId: null, lastSeenAt: null, qrEligible: false });
      expect(byId[linaId].account).toEqual({ status: 'not_eligible', userId: null, lastSeenAt: null, qrEligible: false });
      expect(data.students.map((s) => s.name)).toEqual(['Amal Haddad', 'Lina Haddad', 'Rami Haddad', 'Sami Haddad']);
      expect(data.students[0]).toMatchObject({ photoUrl: null, avatar: null, missingCount: 0 });
      expect(data.counts).toEqual({ students: 4, notSignedIn: 2, missingWork: 0 });
    });

    it('an archived student login shows as archived and is not counted as not signed in', async () => {
      await pool.query(`UPDATE users SET is_archived = TRUE WHERE user_id = $1`, [SAMI_USER_ID]);
      const data = await people(sciId);
      expect(data.students.find((s) => s.studentId === samiId).account.status).toBe('archived');
      expect(data.counts.notSignedIn).toBe(1);
    });

    it('qrEligible follows the school QR grade ceiling', async () => {
      await pool.query(
        `INSERT INTO school_classroom_settings (school, enabled, login_from_grade, qr_until_grade)
         VALUES ('ALHAADIACADEMY', TRUE, '1', '5')`,
      );
      const data = await people(sciId);
      const byId = Object.fromEntries(data.students.map((s) => [s.studentId, s]));
      expect(byId[amalId].account.qrEligible).toBe(true);
      expect(byId[samiId].account.qrEligible).toBe(true);
      expect(byId[ramiId].account.qrEligible).toBe(false);
    });

    it('the displayed avatar is the login pick over the teacher-set one', async () => {
      await pool.query(`UPDATE students SET avatar = $2::jsonb WHERE student_id = ANY($1::uuid[])`, [[amalId, ramiId], JSON.stringify({ style: 'short', skin: 1, bg: 1 })]);
      await pool.query(`UPDATE users SET avatar = $2::jsonb WHERE user_id = $1`, [AMAL_USER_ID, JSON.stringify({ style: 'curly', skin: 3, bg: 5 })]);
      const data = await people(sciId);
      const byId = Object.fromEntries(data.students.map((s) => [s.studentId, s]));
      expect(byId[amalId].avatar).toEqual({ style: 'curly', skin: 3, bg: 5 });
      expect(byId[ramiId].avatar).toEqual({ style: 'short', skin: 1, bg: 1 });
      expect(byId[samiId].avatar).toBeNull();
    });

    it('people parents deduped and hasAccount', async () => {
      await parentLink(amalId, { parentId: MONA_ID, name: 'Mona H.', email: 'mona.haddad@example.com', relation: 'Mother' });
      // The same address on file twice (an unlinked copy typed in another case) is one parent.
      await parentLink(amalId, { name: 'Mona Haddad', email: 'MONA.Haddad@Example.com', relation: 'Mother' });
      await parentLink(amalId, { name: 'Karim Haddad', email: 'karim.haddad@example.com', relation: 'Father' });
      await parentLink(samiId, { parentId: MONA_ID, name: 'Mona H.', email: 'mona.haddad@example.com', relation: 'Mother' });

      const data = await people(sciId);
      const byId = Object.fromEntries(data.students.map((s) => [s.studentId, s]));

      expect(byId[amalId].parents).toEqual([
        { name: 'Mona Haddad', relation: 'Mother', hasAccount: true },
        { name: 'Karim Haddad', relation: 'Father', hasAccount: false },
      ]);
      expect(byId[samiId].parents).toEqual([{ name: 'Mona Haddad', relation: 'Mother', hasAccount: true }]);
      expect(byId[ramiId].parents).toEqual([]);
    });

    it('a parent with no name on file shows as "Parent" and the address never leaves the server', async () => {
      await parentLink(ramiId, { email: 'only.address@example.com' });
      const res = await get(`${BASE}/classes/${sciId}/people`);
      const rami = res.body.data.students.find((s) => s.studentId === ramiId);
      expect(rami.parents).toEqual([{ name: 'Parent', relation: null, hasAccount: false }]);
      expect(JSON.stringify(res.body)).not.toContain('only.address@example.com');
    });

    it('teachers are listed lead first, with the roster header counts', async () => {
      const data = await people(sciId);
      expect(data.teachers.map((t) => [t.name, t.role])).toEqual([['Ziad Teacher', 'lead'], ['Omar Coteacher', 'co']]);
      expect(data.teachers[0].homeroomGrade).toBe('5');
    });

    it('canInvite true only for admin', async () => {
      const teacher = await people(sciId);
      expect(teacher.canInvite).toBe(false);
      expect(teacher.canManageAccounts).toBe(true);
      const co = await people(sciId, asCoTeacher);
      expect(co.canInvite).toBe(false);
      const admin = await people(sciId, asAdmin);
      expect(admin.canInvite).toBe(true);
      expect(admin.canManageAccounts).toBe(true);
    });

    it('403 for a teacher of another class, 404 for an unknown class', async () => {
      const other = await get(`${BASE}/classes/${sciId}/people`, asOtherTeacher);
      expect(other.status).toBe(403);
      const missing = await get(`${BASE}/classes/${UNKNOWN_UUID}/people`);
      expect(missing.status).toBe(404);
    });

    it('student token is refused with STUDENT_FORBIDDEN', async () => {
      const res = await get(`${BASE}/classes/${sciId}/people`, asStudent);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('STUDENT_FORBIDDEN');
    });
  });

  describe('GET /settings', () => {
    it('GET /api/classroom/settings returns defaults', async () => {
      const res = await get(`${BASE}/settings`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: 'success',
        data: { enabled: false, loginFromGrade: '1', qrUntilGrade: '3', parentsReadPrivateComments: true, studentPhotos: false },
      });
    });

    it('reflects what the admin saved', async () => {
      await pool.query(
        `INSERT INTO school_classroom_settings (school, enabled, login_from_grade, qr_until_grade, parents_read_private_comments, student_photos)
         VALUES ('ALHAADIACADEMY', TRUE, '2', '4', FALSE, TRUE)`,
      );
      const res = await get(`${BASE}/settings`, asCoTeacher);
      expect(res.body.data).toEqual({
        enabled: true, loginFromGrade: '2', qrUntilGrade: '4', parentsReadPrivateComments: false, studentPhotos: true,
      });
    });

    it('student token is refused with STUDENT_FORBIDDEN', async () => {
      const res = await get(`${BASE}/settings`, asStudent);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('STUDENT_FORBIDDEN');
    });
  });

  describe('authorization', () => {
    let foreignClassId;

    beforeEach(async () => {
      await pool.query(`INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT DO NOTHING`);
      const foreignYearId = (await pool.query(
        `SELECT school_year_id FROM school_years WHERE school = 'PLAYGROUND' AND is_active LIMIT 1`,
      )).rows[0].school_year_id;
      await pool.query(
        `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
         VALUES ($1, 'yard.admin@example.com', 'Yard Admin', 'hashed', 'Yard', 'Admin', 'PLAYGROUND', 'ADMIN', true, true),
                ($2, 'yard.teacher@example.com', 'Yara Teacher', 'hashed', 'Yara', 'Teacher', 'PLAYGROUND', 'TEACHER', true, true)`,
        [FOREIGN_ADMIN_ID, FOREIGN_TEACHER_ID],
      );
      foreignClassId = (await pool.query(
        `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_name, school_year_id)
         VALUES ('PLAYGROUND', '5', 'Science', 'Yara Teacher', $1, 'Term 1', $2) RETURNING class_id`,
        [FOREIGN_TEACHER_ID, foreignYearId],
      )).rows[0].class_id;
    });

    it("another school's classes never reach this school's admin, in the list, header or People", async () => {
      const list = await cards('', asAdmin);
      expect(list.classes.map((c) => c.classId)).not.toContain(foreignClassId);

      const header = await get(`${BASE}/classes/${foreignClassId}`, asAdmin);
      expect(header.status).toBe(403);
      const roster = await get(`${BASE}/classes/${foreignClassId}/people`, asAdmin);
      expect(roster.status).toBe(403);
    });

    it("this school's classes never reach another school's admin", async () => {
      const list = await cards('', asForeignAdmin);
      expect(list.classes.map((c) => c.classId)).toEqual([foreignClassId]);

      const header = await get(`${BASE}/classes/${sciId}`, asForeignAdmin);
      expect(header.status).toBe(403);
      const roster = await get(`${BASE}/classes/${sciId}/people`, asForeignAdmin);
      expect(roster.status).toBe(403);
    });

    it('a teacher of another school is refused a class by its id', async () => {
      const asForeignTeacher = { ...asTeacher, userId: FOREIGN_TEACHER_ID, school: 'PLAYGROUND' };
      const res = await get(`${BASE}/classes/${sciId}`, asForeignTeacher);
      expect(res.status).toBe(403);
    });

    it.each([
      ['the list', () => `${BASE}/classes`],
      ['the header', (ids) => `${BASE}/classes/${ids.sciId}`],
      ['People', (ids) => `${BASE}/classes/${ids.sciId}/people`],
      ['the settings', () => `${BASE}/settings`],
    ])('a parent token is refused %s', async (_label, url) => {
      const res = await get(url({ sciId }), asParent);
      expect(res.status).toBe(403);
      expect(res.body.status).toBe('failed');
    });
  });
});
