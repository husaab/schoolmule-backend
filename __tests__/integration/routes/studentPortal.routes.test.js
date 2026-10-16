// The student portal read API: home, class cards, the class header, the class
// Stream, People (teachers only) and published-only grades. Every read keys on
// the caller's own student row; a classmate's work or grades never appear.
// Synthetic identities only (@example.com).

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient');

const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const CO_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440002';
const OTHER_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440003';
const PARENT_ID = '550e8400-e29b-41d4-a716-446655440004';
const AMAL_USER_ID = '550e8400-e29b-41d4-a716-446655440010';

const asAmal = { userId: AMAL_USER_ID, username: 'Amal Haddad', email: 'amal.haddad@example.com', role: 'STUDENT', roles: ['STUDENT'] };
const asParent = { userId: PARENT_ID, username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };

describe('Integration: the student portal read API', () => {
  let pool, yearId, term1Id, term2Id;
  let mathId, sciId, artId, archivedId, otherId;
  let amalId, bilalId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, 'ALHAADIACADEMY', $6, true, true)`,
    [id, email, `${first} ${last}`, first, last, role],
  );
  const term = (name, start, end, active) => pool.query(
    `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id)
     VALUES ('ALHAADIACADEMY', $1, $2, $3, $4, $5) RETURNING term_id`,
    [name, start, end, active, yearId],
  ).then((r) => r.rows[0].term_id);
  const makeClass = (subject, teacherId, termId, termName, extra = {}) => pool.query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id, archived_at, show_class_average)
     VALUES ('ALHAADIACADEMY', '5', $1, 'Lead Name', $2, $3, $4, $5, $6, $7) RETURNING class_id`,
    [subject, teacherId, termId, termName, yearId, extra.archivedAt ?? null, extra.showClassAverage ?? false],
  ).then((r) => r.rows[0].class_id);
  const makeStudent = (name) => pool.query(
    `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id) VALUES ($1, '5', 'ALHAADIACADEMY', $2, $3) RETURNING student_id`,
    [name, yearId, TEACHER_ID],
  ).then((r) => r.rows[0].student_id);
  const enrol = (classId, studentId) => pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, studentId]);
  const assessment = (classId, name, { published = false, publishedAt = null, max = 10, comment = null } = {}) => pool.query(
    `INSERT INTO assessments (class_id, name, weight_points, max_score, is_parent, date, is_published, published_at, parent_comment)
     VALUES ($1, $2, 10, $3, FALSE, DATE '2026-10-01', $4, $5, $6) RETURNING assessment_id`,
    [classId, name, max, published, publishedAt, comment],
  ).then((r) => r.rows[0].assessment_id);
  const score = (studentId, assessmentId, value, status = 'graded') => pool.query(
    `INSERT INTO student_assessments (student_id, assessment_id, score, status) VALUES ($1, $2, $3, $4)`,
    [studentId, assessmentId, value, status],
  );
  const announce = (classId, title, { daysAgo = 0, ack = false } = {}) => pool.query(
    `INSERT INTO announcements (school, school_year_id, scope, class_id, title, body, author_id, author_role, ack_requested, published_at)
     VALUES ('ALHAADIACADEMY', $1, 'class', $2, $3, 'Body text', $4, 'TEACHER', $5, NOW() - make_interval(days => $6))
     RETURNING announcement_id`,
    [yearId, classId, title, TEACHER_ID, ack, daysAgo],
  ).then((r) => r.rows[0].announcement_id);

  const get = async (url, who = asAmal, status = 200) => {
    const res = await authenticatedRequest('get', url, who);
    expect(res.status).toBe(status);
    return res.body;
  };

  beforeEach(async () => {
    supabase._reset();
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;

    await user(TEACHER_ID, 'ziad.teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(CO_TEACHER_ID, 'lina.coteacher@example.com', 'Lina', 'Coteacher', 'TEACHER');
    await user(OTHER_TEACHER_ID, 'dina.teacher@example.com', 'Dina', 'Teacher', 'TEACHER');
    await user(PARENT_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    await user(AMAL_USER_ID, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT');
    await pool.query(`UPDATE users SET avatar = '{"style":"hijab","skin":2,"bg":3}' WHERE user_id = $1`, [AMAL_USER_ID]);
    await pool.query(`INSERT INTO school_classroom_settings (school, enabled) VALUES ('ALHAADIACADEMY', TRUE)`);

    term1Id = await term('Term 1', '2025-09-01', '2025-11-30', false);
    term2Id = await term('Term 2', '2025-12-01', '2026-06-30', true);

    mathId = await makeClass('Math', TEACHER_ID, term2Id, 'Term 2');
    sciId = await makeClass('Science', OTHER_TEACHER_ID, term2Id, 'Term 2');
    artId = await makeClass('Art', OTHER_TEACHER_ID, term1Id, 'Term 1');
    archivedId = await makeClass('French', OTHER_TEACHER_ID, term2Id, 'Term 2', { archivedAt: new Date() });
    otherId = await makeClass('Arabic', OTHER_TEACHER_ID, term2Id, 'Term 2');
    await pool.query(`INSERT INTO class_teachers (class_id, teacher_id) VALUES ($1, $2)`, [mathId, CO_TEACHER_ID]);

    amalId = await makeStudent('Amal Haddad');
    bilalId = await makeStudent('Bilal Karim');
    for (const c of [mathId, sciId, artId, archivedId]) await enrol(c, amalId);
    await enrol(mathId, bilalId);
    await enrol(otherId, bilalId);
    await pool.query(
      `INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [AMAL_USER_ID, amalId, yearId],
    );
  });

  it("home lists only the student's current-term classes with identity and lead teacher", async () => {
    const { data } = await get('/api/student/home');

    expect(data.student).toEqual({
      studentId: amalId, name: 'Amal Haddad', firstName: 'Amal', grade: '5', avatar: { style: 'hijab', skin: 2, bg: 3 },
    });
    expect(data.dueSoon).toEqual([]);
    expect(data.missing).toEqual([]);
    expect(data.classes.map((c) => c.subject)).toEqual(['Math', 'Science']);

    const [math] = data.classes;
    expect(math).toMatchObject({
      classId: mathId, subject: 'Math', grade: '5', termName: 'Term 2',
      teacher: { userId: TEACHER_ID, name: 'Ziad Teacher', role: 'lead', avatar: null },
      next: null, missingCount: 0, hasNewPost: false,
    });
    expect(math.teachers.map((t) => [t.name, t.role])).toEqual([['Ziad Teacher', 'lead'], ['Lina Coteacher', 'co']]);
    expect(math.identity).toMatchObject({
      family: 'math', bannerUrl: '/class-banners/math.svg', iconUrl: '/class-icons/math.svg', color: 'blue', bannerIsUpload: false,
    });

    const listed = await get('/api/student/classes');
    expect(listed.data.classes).toEqual(data.classes);
  });

  it('past-term classes are not listed', async () => {
    const { data } = await get('/api/student/classes');
    expect(data.classes.map((c) => c.classId)).not.toContain(artId);
  });

  it('an archived class is not listed and its page is 404 NOT_ENROLLED', async () => {
    const { data } = await get('/api/student/classes');
    expect(data.classes.map((c) => c.classId)).not.toContain(archivedId);
    for (const path of ['', '/stream', '/people']) {
      const body = await get(`/api/student/classes/${archivedId}${path}`, asAmal, 404);
      expect(body.code).toBe('NOT_ENROLLED');
    }
  });

  it('a class the student is not in is 404 NOT_ENROLLED', async () => {
    for (const path of ['', '/stream', '/people']) {
      const body = await get(`/api/student/classes/${otherId}${path}`, asAmal, 404);
      expect(body).toMatchObject({ status: 'failed', code: 'NOT_ENROLLED' });
    }
    await get('/api/student/classes/not-a-uuid', asAmal, 404);
  });

  it('the class header has the teachers and the lead teacher to message', async () => {
    const { data } = await get(`/api/student/classes/${mathId}`);
    expect(data.upcoming).toEqual([]);
    expect(data.class).toMatchObject({ classId: mathId, subject: 'Math', grade: '5', termName: 'Term 2' });
    expect(data.class.identity.family).toBe('math');
    expect(data.class.teachers.map((t) => [t.userId, t.role])).toEqual([[TEACHER_ID, 'lead'], [CO_TEACHER_ID, 'co']]);
    expect(data.class.messageTeacher).toEqual({ userId: TEACHER_ID, name: 'Ziad Teacher', avatar: null, photoUrl: null });
  });

  it('people returns teachers and never classmates', async () => {
    const { data } = await get(`/api/student/classes/${mathId}/people`);
    expect(Object.keys(data)).toEqual(['teachers']);
    expect(data.teachers.map((t) => [t.name, t.role])).toEqual([['Ziad Teacher', 'lead'], ['Lina Coteacher', 'co']]);
    const raw = JSON.stringify(data);
    expect(raw).not.toContain(bilalId);
    expect(raw).not.toContain('Bilal');
  });

  it("the class stream holds only that class's posts, with the student's read state", async () => {
    const mathPost = await announce(mathId, 'Bring a ruler');
    await announce(sciId, 'Lab goggles');
    const { data } = await get(`/api/student/classes/${mathId}/stream`);
    expect(data.notices).toEqual([]);
    expect(data.announcements.map((a) => [a.announcementId, a.title, a.read])).toEqual([[mathPost, 'Bring a ruler', false]]);
    expect(data.announcements[0].author).toMatchObject({ userId: TEACHER_ID, name: 'Ziad Teacher' });
  });

  it('grades show a published score and hide an unpublished one', async () => {
    const quiz1 = await assessment(mathId, 'Quiz 1', { published: true, publishedAt: new Date(), comment: 'Well done' });
    const quiz2 = await assessment(mathId, 'Quiz 2');
    await score(amalId, quiz1, 8);
    await score(amalId, quiz2, 3);
    await score(bilalId, quiz1, 6);

    const { data } = await get('/api/student/grades');

    expect(data).toMatchObject({ studentId: amalId, usesMarks: true, termId: term2Id });
    expect(data.terms.map((t) => [t.name, t.isActive])).toEqual([['Term 1', false], ['Term 2', true]]);
    expect(data.classes.map((c) => c.subject)).toEqual(['Math', 'Science']);
    const math = data.classes[0];
    expect(math).toMatchObject({ classId: mathId, finalPct: 80, classAvg: null, gradedCount: 1, missingCount: 0 });
    expect(math.items).toHaveLength(1);
    expect(math.items[0]).toMatchObject({
      assessmentId: quiz1, title: 'Quiz 1', kind: 'assessment', score: 8, maxScore: 10, status: 'graded', parentComment: 'Well done',
    });
    const raw = JSON.stringify(data);
    expect(raw).not.toContain(quiz2);
    expect(raw).not.toContain(bilalId);

    // A past term is a ?termId away.
    const past = await get(`/api/student/grades?termId=${term1Id}`);
    expect(past.data.termId).toBe(term1Id);
    expect(past.data.classes.map((c) => c.subject)).toEqual(['Art']);
    await get('/api/student/grades?termId=junk', asAmal, 400);
  });

  it('newGrades only includes the last 14 days', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const recent = await assessment(mathId, 'Fractions quiz', { published: true, publishedAt: new Date(Date.now() - 3 * DAY) });
    const old = await assessment(mathId, 'Decimals quiz', { published: true, publishedAt: new Date(Date.now() - 20 * DAY) });
    await score(amalId, recent, 9);
    await score(amalId, old, 7);

    const { data } = await get('/api/student/home');
    expect(data.newGrades.map((g) => [g.assessmentId, g.title, g.score])).toEqual([[recent, 'Fractions quiz', 9]]);
  });

  it('hasNewPost true for an unread class post this week, false after POST read', async () => {
    const post = await announce(mathId, 'Field trip form');
    await announce(sciId, 'An old post', { daysAgo: 9 });

    let cards = (await get('/api/student/classes')).data.classes;
    expect(cards.map((c) => [c.subject, c.hasNewPost])).toEqual([['Math', true], ['Science', false]]);

    const read = await authenticatedRequest('post', `/api/student/announcements/${post}/read`, asAmal);
    expect(read.status).toBe(200);

    cards = (await get('/api/student/classes')).data.classes;
    expect(cards.map((c) => [c.subject, c.hasNewPost])).toEqual([['Math', false], ['Science', false]]);
  });

  it('a JK student does not use marks', async () => {
    await pool.query(`UPDATE students SET grade = 'JK' WHERE student_id = $1`, [amalId]);
    const { data } = await get('/api/student/grades');
    expect(data).toMatchObject({ studentId: amalId, usesMarks: false, classes: [] });
  });

  it('only a student reaches the student portal', async () => {
    for (const url of ['/api/student/home', '/api/student/classes', `/api/student/classes/${mathId}`, '/api/student/grades']) {
      const body = await get(url, asParent, 403);
      expect(body.message).toBe('Student access required');
    }
  });
});
