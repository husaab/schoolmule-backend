// The parent's Classes page: the summary ("Needs you" + a card per child) and
// the read-only lens into one child's classes, which reuses the student
// portal's read model with the parent as the reader. Synthetic identities only
// (@example.com).

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient');

const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const OTHER_TEACHER_ID = '550e8400-e29b-41d4-a716-446655440003';
const MONA_ID = '550e8400-e29b-41d4-a716-446655440004';
const OMAR_ID = '550e8400-e29b-41d4-a716-446655440005';
const AMAL_USER_ID = '550e8400-e29b-41d4-a716-446655440010';
const SARA_USER_ID = '550e8400-e29b-41d4-a716-446655440011';

const asMona = { userId: MONA_ID, username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'ziad.teacher@example.com', role: 'TEACHER' };
const asAmal = { userId: AMAL_USER_ID, username: 'Amal Haddad', email: 'amal.haddad@example.com', role: 'STUDENT', roles: ['STUDENT'] };

const DAY = 24 * 60 * 60 * 1000;

describe("Integration: the parent's Classes page and lens", () => {
  let pool, yearId, pastYearId, termId;
  let mathId, sciId, readingId, archivedId;
  let amalId, saraId, ramiId, pastAmalId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, 'ALHAADIACADEMY', $6, true, true)`,
    [id, email, `${first} ${last}`, first, last, role],
  );
  const makeClass = (subject, grade, teacherId, extra = {}) => pool.query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name, school_year_id, archived_at)
     VALUES ('ALHAADIACADEMY', $1, $2, 'Lead Name', $3, $4, 'Term 1', $5, $6) RETURNING class_id`,
    [grade, subject, teacherId, termId, yearId, extra.archivedAt ?? null],
  ).then((r) => r.rows[0].class_id);
  const makeStudent = (name, grade, year = yearId) => pool.query(
    `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id) VALUES ($1, $2, 'ALHAADIACADEMY', $3, $4) RETURNING student_id`,
    [name, grade, year, TEACHER_ID],
  ).then((r) => r.rows[0].student_id);
  const enrol = (classId, studentId) => pool.query(`INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)`, [classId, studentId]);
  const guardian = (studentId, parentId, name, email) => pool.query(
    `INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school) VALUES ($1, $2, $3, $4, 'Mother', 'ALHAADIACADEMY')`,
    [studentId, parentId, name, email],
  );
  const publishedQuiz = async (classId, name, publishedAt) => (await pool.query(
    `INSERT INTO assessments (class_id, name, weight_points, max_score, is_parent, date, is_published, published_at)
     VALUES ($1, $2, 10, 10, FALSE, DATE '2026-10-01', TRUE, $3) RETURNING assessment_id`,
    [classId, name, publishedAt],
  )).rows[0].assessment_id;
  const score = (studentId, assessmentId, value) => pool.query(
    `INSERT INTO student_assessments (student_id, assessment_id, score) VALUES ($1, $2, $3)`, [studentId, assessmentId, value],
  );
  const announce = ({ scope = 'class', classId = null, title, daysAgo = 0, ack = false, deleted = false }) => pool.query(
    `INSERT INTO announcements (school, school_year_id, scope, class_id, title, body, author_id, author_role, ack_requested, published_at, deleted_at)
     VALUES ('ALHAADIACADEMY', $1, $2, $3, $4, 'Body text', $5, 'TEACHER', $6, NOW() - make_interval(days => $7),
             CASE WHEN $8::boolean THEN NOW() END)
     RETURNING announcement_id`,
    [yearId, scope, classId, title, TEACHER_ID, ack, daysAgo, deleted],
  ).then((r) => r.rows[0].announcement_id);

  const get = async (url, who = asMona, status = 200) => {
    const res = await authenticatedRequest('get', url, who);
    expect(res.status).toBe(status);
    return res.body;
  };
  const lens = (studentId, path = '') => `/api/parent-portal/students/${studentId}/classroom${path}`;

  beforeEach(async () => {
    supabase._reset();
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    pastYearId = (await pool.query(
      `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
       SELECT 'ALHAADIACADEMY', school_id, '2024-2025', DATE '2024-09-01', DATE '2025-06-30', FALSE
         FROM schools WHERE school_code = 'ALHAADIACADEMY'
       RETURNING school_year_id`,
    )).rows[0].school_year_id;
    termId = (await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, is_active, school_year_id)
       VALUES ('ALHAADIACADEMY', 'Term 1', '2025-09-01', '2026-06-30', TRUE, $1) RETURNING term_id`, [yearId],
    )).rows[0].term_id;

    await user(TEACHER_ID, 'ziad.teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(OTHER_TEACHER_ID, 'dina.teacher@example.com', 'Dina', 'Teacher', 'TEACHER');
    await user(MONA_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    await user(OMAR_ID, 'omar.saleh@example.com', 'Omar', 'Saleh', 'PARENT');
    await user(AMAL_USER_ID, 'amal.haddad@example.com', 'Amal', 'Haddad', 'STUDENT');
    await pool.query(`INSERT INTO school_classroom_settings (school, enabled, login_from_grade) VALUES ('ALHAADIACADEMY', TRUE, '1')`);

    mathId = await makeClass('Math', '5', TEACHER_ID);
    sciId = await makeClass('Science', '5', OTHER_TEACHER_ID);
    readingId = await makeClass('English', '2', TEACHER_ID);
    archivedId = await makeClass('French', '5', OTHER_TEACHER_ID, { archivedAt: new Date() });

    amalId = await makeStudent('Amal Haddad', '5');
    saraId = await makeStudent('Sara Haddad', '2');
    ramiId = await makeStudent('Rami Saleh', '5');
    pastAmalId = await makeStudent('Amal Haddad', '4', pastYearId);
    for (const c of [mathId, sciId, archivedId]) await enrol(c, amalId);
    await enrol(readingId, saraId);
    await enrol(mathId, ramiId);

    await guardian(amalId, MONA_ID, 'Mona Haddad', 'mona.haddad@example.com');
    await guardian(saraId, MONA_ID, 'Mona Haddad', 'mona.haddad@example.com');
    await guardian(pastAmalId, MONA_ID, 'Mona Haddad', 'mona.haddad@example.com');
    await guardian(ramiId, OMAR_ID, 'Omar Saleh', 'omar.saleh@example.com');

    // Amal signs in: a consented login linked to this year's row. Sara has no login.
    await pool.query(
      `INSERT INTO student_accounts (user_id, school, consent_at, consent_notice_version) VALUES ($1, 'ALHAADIACADEMY', NOW(), '2026-10')`,
      [AMAL_USER_ID],
    );
    await pool.query(
      `INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [AMAL_USER_ID, amalId, yearId],
    );
  });

  it('summary lists each child for the selected year with counts and latest grade', async () => {
    const fresh = await publishedQuiz(mathId, 'Fractions quiz', new Date(Date.now() - 2 * DAY));
    const older = await publishedQuiz(sciId, 'Cells quiz', new Date(Date.now() - 10 * DAY));
    await score(amalId, fresh, 8);
    await score(amalId, older, 9);
    const readingPost = await announce({ classId: readingId, title: 'Library day', daysAgo: 1 });
    await announce({ classId: readingId, title: 'Older news', daysAgo: 3 });
    await announce({ classId: readingId, title: 'Oldest news', daysAgo: 5 });

    const { data } = await get('/api/parent-portal/classroom/summary');

    expect(data.children.map((c) => c.studentId)).toEqual([saraId, amalId]); // this year's rows only, Grade 2 before Grade 5
    const [sara, amal] = data.children;
    expect(amal).toMatchObject({
      studentId: amalId, name: 'Amal Haddad', grade: '5', avatar: null, signsIn: true, classCount: 2,
      dueThisWeek: 0, missingCount: 0, newGradeCount: 1, homeroomTeacherName: 'Ziad Teacher',
    });
    expect(amal.latestGrade).toMatchObject({ assessmentId: fresh, title: 'Fractions quiz', score: 8, maxScore: 10, subject: 'Math' });
    expect(sara).toMatchObject({ studentId: saraId, grade: '2', signsIn: false, classCount: 1, newGradeCount: 0, latestGrade: null });
    expect(sara.recentPosts.map((p) => p.title)).toEqual(['Library day', 'Older news']);
    expect(sara.recentPosts[0]).toMatchObject({ announcementId: readingPost, classSubject: 'English', read: false });
    expect(JSON.stringify(data)).not.toContain(ramiId);
  });

  it("T12: recent posts leave out an archived class's posts, as the class list does", async () => {
    await announce({ classId: archivedId, title: 'French club', daysAgo: 1 });
    await announce({ classId: sciId, title: 'Lab coats', daysAgo: 2 });
    const { data } = await get('/api/parent-portal/classroom/summary');
    const amal = data.children.find((c) => c.studentId === amalId);
    expect(amal.recentPosts.map((p) => p.title)).toEqual(['Lab coats']);
  });

  it('needsYou has an ack item for an unacknowledged ack-requested post and drops it after POST /api/announcements/:id/ack', async () => {
    const mathAck = await announce({ classId: mathId, title: 'Sign the trip form', daysAgo: 1, ack: true });
    const schoolAck = await announce({ scope: 'school', title: 'Read the new policy', ack: true });
    await announce({ classId: mathId, title: 'No ack wanted' });
    await announce({ classId: mathId, title: 'Too old to need you', daysAgo: 31, ack: true });
    await announce({ classId: mathId, title: 'Removed', ack: true, deleted: true });
    await announce({ classId: archivedId, title: 'From an archived class', ack: true }); // Amal is on its roster

    let { needsYou } = (await get('/api/parent-portal/classroom/summary')).data;
    expect(needsYou).toEqual([
      expect.objectContaining({
        kind: 'ack', announcementId: schoolAck, title: 'Read the new policy', classSubject: null, authorName: 'Ziad Teacher',
        studentIds: [amalId, saraId],
      }),
      expect.objectContaining({
        kind: 'ack', announcementId: mathAck, title: 'Sign the trip form', classSubject: 'Math', authorName: 'Ziad Teacher',
        studentIds: [amalId],
      }),
    ]);
    expect(needsYou[0].publishedAt).toEqual(expect.any(String));

    const acked = await authenticatedRequest('post', `/api/announcements/${mathAck}/ack`, asMona);
    expect(acked.status).toBe(200);

    ({ needsYou } = (await get('/api/parent-portal/classroom/summary')).data);
    expect(needsYou.map((n) => n.announcementId)).toEqual([schoolAck]);
  });

  it('signsIn is true for a password or a live QR card, and false when the sign-in gate would refuse', async () => {
    // Sara (Grade 2) gets a login: invite pending (no password yet), consent on file, a live card.
    await user(SARA_USER_ID, 'sara.haddad@example.com', 'Sara', 'Haddad', 'STUDENT');
    await pool.query(`UPDATE users SET password = '!' WHERE user_id = $1`, [SARA_USER_ID]);
    await pool.query(
      `INSERT INTO student_accounts (user_id, school, consent_at, consent_notice_version, qr_secret_hash, qr_issued_at)
       VALUES ($1, 'ALHAADIACADEMY', NOW(), '2026-10', 'card-hash', NOW())`, [SARA_USER_ID],
    );
    await pool.query(
      `INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [SARA_USER_ID, saraId, yearId],
    );
    // The lens's classes payload carries the same flag (the P2 "doesn't sign in" note).
    const signsIn = async () => {
      const card = (await get('/api/parent-portal/classroom/summary')).data.children.find((c) => c.studentId === saraId).signsIn;
      expect((await get(lens(saraId, '/classes'))).data.signsIn).toBe(card);
      return card;
    };
    const account = (sql) => pool.query(`UPDATE student_accounts SET ${sql} WHERE user_id = $1`, [SARA_USER_ID]);
    const settings = (sql) => pool.query(`UPDATE school_classroom_settings SET ${sql} WHERE school = 'ALHAADIACADEMY'`);

    expect(await signsIn()).toBe(true); // QR-only invitee: the card is the way in

    await account('qr_voided_at = NOW()');
    expect(await signsIn()).toBe(false); // voided card, no password

    await account('qr_voided_at = NULL, qr_secret_hash = NULL, qr_issued_at = NULL');
    expect(await signsIn()).toBe(false); // invite pending, no card

    await pool.query(`UPDATE users SET password = 'hashed' WHERE user_id = $1`, [SARA_USER_ID]);
    expect(await signsIn()).toBe(true); // password set

    await account('consent_at = NULL');
    expect(await signsIn()).toBe(false); // no consent
    await account('consent_at = NOW()');

    await settings(`login_from_grade = '3'`);
    expect(await signsIn()).toBe(false); // Grade 2 is below the login grade
    await settings(`login_from_grade = '1'`);

    await settings('enabled = FALSE');
    expect(await signsIn()).toBe(false); // classrooms off
    await settings('enabled = TRUE');

    await pool.query(`UPDATE users SET is_archived = TRUE WHERE user_id = $1`, [SARA_USER_ID]);
    expect(await signsIn()).toBe(false); // archived login
    await pool.query(`UPDATE users SET is_archived = FALSE, password = '!' WHERE user_id = $1`, [SARA_USER_ID]);

    await account(`qr_secret_hash = 'card-hash', qr_issued_at = NOW()`);
    expect(await signsIn()).toBe(true);
    await settings(`qr_until_grade = '1'`);
    expect(await signsIn()).toBe(false); // a card only works up to the school's QR grade
  });

  it("lens endpoints 404 for a linked child whose row is archived or in another school", async () => {
    await pool.query(`UPDATE students SET is_archived = TRUE WHERE student_id = $1`, [saraId]);
    const elsewhere = (await pool.query(
      `INSERT INTO students (name, grade, school) VALUES ('Lina Haddad', '5', 'PLAYGROUND') RETURNING student_id`,
    )).rows[0].student_id;
    await guardian(elsewhere, MONA_ID, 'Mona Haddad', 'mona.haddad@example.com');
    for (const id of [saraId, elsewhere]) {
      for (const path of ['/classes', `/classes/${readingId}`, `/classes/${readingId}/stream`, '/grades']) {
        const body = await get(lens(id, path), asMona, 404);
        expect(body.message).toBe('Student not found');
      }
    }
  });

  it("lens endpoints 403 for another family's child", async () => {
    for (const path of ['/classes', `/classes/${mathId}`, `/classes/${mathId}/stream`, '/grades']) {
      await get(lens(ramiId, path), asMona, 403);
    }
    await get(lens('not-a-uuid', '/classes'), asMona, 403);
  });

  it("the lens lists the child's current classes and opens one with the lead teacher to message", async () => {
    const lensClasses = (await get(lens(amalId, '/classes'))).data;
    expect(lensClasses.signsIn).toBe(true);
    expect((await get(lens(saraId, '/classes'))).data.signsIn).toBe(false); // Sara has no login
    const { classes } = lensClasses;
    expect(classes.map((c) => c.subject)).toEqual(['Math', 'Science']); // archived French hidden
    const student = (await get('/api/student/classes', asAmal)).data.classes;
    expect(classes).toEqual(student);

    const { data } = await get(lens(amalId, `/classes/${mathId}`));
    expect(data.upcoming).toEqual([]);
    expect(data.class).toMatchObject({ classId: mathId, subject: 'Math', messageTeacher: { userId: TEACHER_ID, name: 'Ziad Teacher' } });

    for (const id of [archivedId, readingId]) {
      const body = await get(lens(amalId, `/classes/${id}`), asMona, 404);
      expect(body.code).toBe('NOT_ENROLLED');
    }
  });

  it("lens stream reports the parent's own ack state", async () => {
    const ackPost = await announce({ classId: mathId, title: 'Sign the trip form', daysAgo: 1, ack: true });
    const news = await announce({ classId: mathId, title: 'Bring a ruler' });
    const acked = await authenticatedRequest('post', `/api/announcements/${ackPost}/ack`, asMona); // "Got it" also marks it read
    expect(acked.status).toBe(200);
    for (const id of [ackPost, news]) {
      const studentRead = await authenticatedRequest('post', `/api/student/announcements/${id}/read`, asAmal);
      expect(studentRead.status).toBe(200);
    }

    const parentView = (await get(lens(amalId, `/classes/${mathId}/stream`))).data;
    expect(parentView.notices).toEqual([]);
    const parentPosts = Object.fromEntries(parentView.announcements.map((a) => [a.announcementId, a]));
    expect(parentPosts[ackPost]).toMatchObject({ ackRequested: true, read: true, ackedAt: expect.any(String) });
    expect(parentPosts[news]).toMatchObject({ ackRequested: false, read: false, ackedAt: null });

    const studentView = (await get(`/api/student/classes/${mathId}/stream`, asAmal)).data;
    const studentPosts = Object.fromEntries(studentView.announcements.map((a) => [a.announcementId, a]));
    expect(studentPosts[ackPost]).toMatchObject({ ackRequested: true, read: true, ackedAt: null });
    expect(studentPosts[news]).toMatchObject({ read: true });

    // The parent's unread post marks the card as new for the parent, not for the student.
    const lensCards = (await get(lens(amalId, '/classes'))).data.classes;
    expect(lensCards.find((c) => c.classId === mathId).hasNewPost).toBe(true);
    const studentCards = (await get('/api/student/classes', asAmal)).data.classes;
    expect(studentCards.find((c) => c.classId === mathId).hasNewPost).toBe(false);
  });

  it("lens grades equal the student's own grades payload (same function, same numbers)", async () => {
    const quiz = await publishedQuiz(mathId, 'Fractions quiz', new Date(Date.now() - DAY));
    await score(amalId, quiz, 7);
    await score(ramiId, quiz, 10);

    const studentGrades = (await get('/api/student/grades', asAmal)).data;
    const lensGrades = (await get(lens(amalId, '/grades'))).data;

    expect(lensGrades).toEqual(studentGrades);
    expect(lensGrades.classes[0]).toMatchObject({ subject: 'Math', finalPct: 70, gradedCount: 1 });
    expect(JSON.stringify(lensGrades)).not.toContain(ramiId);
  });

  it('only a parent reaches the Classes API', async () => {
    const asStudent = await get('/api/parent-portal/classroom/summary', asAmal, 403);
    expect(asStudent.code).toBe('STUDENT_FORBIDDEN');
    const asStaff = await get('/api/parent-portal/classroom/summary', asTeacher, 403);
    expect(asStaff.message).toBe('Parent access required');
  });
});
