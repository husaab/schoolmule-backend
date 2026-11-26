// Report comment rules against a real database: the school's word limits and
// the review lock (whole term, with a class's exception), on every route that
// writes report card or progress report comments.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const { countWords } = require('../../../utils/wordCount');
const { wordCountSql } = require('../../../utils/wordCount');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const TEACHER = { userId: TEACHER_ID, role: 'TEACHER', email: 'teacher@test.com', username: 'Teacher One' };

const asAdmin = (method, url) => authenticatedRequest(method, url);
const asTeacher = (method, url) => authenticatedRequest(method, url, TEACHER);
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('Integration: report comment rules', () => {
  let pool;
  let termId;
  let classId;
  let otherClassId;
  let studentId;
  let otherStudentId;

  beforeAll(() => { pool = getTestPool(); });

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, 'admin@test.com', 'Admin User', 'hashed', 'Ada', 'Admin', 'ALHAADIACADEMY', 'ADMIN', true, true),
              ($2, 'teacher@test.com', 'Teacher One', 'hashed', 'Teacher', 'One', 'ALHAADIACADEMY', 'TEACHER', true, true)`,
      [ADMIN_ID, TEACHER_ID],
    );
    const { rows: term } = await pool.query(
      `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active, school_year_id)
       SELECT 'ALHAADIACADEMY', 'Term 1', '2025-09-01', '2026-01-31', '2025-2026', true,
              (SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1)
       RETURNING term_id`,
    );
    termId = term[0].term_id;
    const { rows: classes } = await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
       VALUES ('ALHAADIACADEMY', '5', 'Math', 'Teacher One', $1, $2, 'Term 1'),
              ('ALHAADIACADEMY', '5', 'Science', 'Teacher One', $1, $2, 'Term 1')
       RETURNING class_id, subject`,
      [TEACHER_ID, termId],
    );
    classId = classes.find((c) => c.subject === 'Math').class_id;
    otherClassId = classes.find((c) => c.subject === 'Science').class_id;
    const { rows: students } = await pool.query(
      `INSERT INTO students (name, school, grade) VALUES ('Amal', 'ALHAADIACADEMY', '5'), ('Bilal', 'ALHAADIACADEMY', '5')
       RETURNING student_id, name`,
    );
    studentId = students.find((s) => s.name === 'Amal').student_id;
    otherStudentId = students.find((s) => s.name === 'Bilal').student_id;
    await pool.query(
      'INSERT INTO class_students (class_id, student_id) VALUES ($1, $3), ($1, $4), ($2, $3)',
      [classId, otherClassId, studentId, otherStudentId],
    );
  });

  const lockTerm = (kind, locked = true) => asAdmin('put', '/api/report-comments/locks/term').send({ termId, kind, locked });
  const lockClass = (id, kind, locked) => asAdmin('put', '/api/report-comments/locks/class').send({ classId: id, kind, locked });
  const setLimits = (reportCard, progressReport = {}) => asAdmin('put', '/api/report-comments/limits').send({ reportCard, progressReport });
  const saveReportCard = (as, id, comment, student = studentId) =>
    as('post', '/api/report-cards/feedback/bulk').send({ feedbackEntries: [{ studentId: student, classId: id, workHabits: 'G', behavior: 'G', comment }] });
  const saveProgress = (as, id, comment, student = studentId) =>
    as('post', '/api/progress-reports/feedback/bulk').send({ feedbackEntries: [{ studentId: student, classId: id, workHabit: 'G', comment }] });
  const savedReportCard = async (id = classId, student = studentId) =>
    (await pool.query('SELECT comment FROM report_card_feedback WHERE class_id = $1 AND student_id = $2', [id, student])).rows[0]?.comment ?? null;
  const savedProgress = async (id = classId, student = studentId) =>
    (await pool.query('SELECT comment FROM progress_report_feedback WHERE class_id = $1 AND student_id = $2', [id, student])).rows[0]?.comment ?? null;
  const classRules = async (as = asTeacher, id = classId) => (await as('get', `/api/report-comments/class/${id}`)).body.data;

  describe('the word counter', () => {
    it('counts the same words in SQL as in JavaScript', async () => {
      const samples = ['', '   ', 'one', '  one two\tthree\nfour\r\nfive six  ', 'reading - and writing', "well-behaved, isn't she?", 'a\n\n\nb'];
      for (const text of samples) {
        const { rows } = await pool.query(`SELECT ${wordCountSql('$1::text')} AS n`, [text]);
        expect([text, rows[0].n]).toEqual([text, countWords(text)]);
      }
    });
  });

  describe('limits', () => {
    it('start with none, save, and reach the class pages', async () => {
      expect((await classRules()).reportCard).toMatchObject({ minWords: null, maxWords: null, locked: false });

      const res = await setLimits({ minWords: 5, maxWords: 10 }, { maxWords: 8 });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        reportCard: { minWords: 5, maxWords: 10 },
        progressReport: { minWords: null, maxWords: 8 },
      });

      const rules = await classRules();
      expect(rules.reportCard).toMatchObject({ minWords: 5, maxWords: 10 });
      expect(rules.progressReport).toMatchObject({ minWords: null, maxWords: 8 });
      expect(rules.canEditLocked).toBe(false);
      expect((await classRules(asAdmin)).canEditLocked).toBe(true);
    });

    it('are refused when the minimum is above the maximum, and for a teacher', async () => {
      expect((await setLimits({ minWords: 11, maxWords: 10 })).status).toBe(400);
      const res = await asTeacher('put', '/api/report-comments/limits').send({ reportCard: {}, progressReport: {} });
      expect(res.status).toBe(403);
    });

    it('refuse a comment over the maximum and save one under the minimum', async () => {
      await setLimits({ minWords: 5, maxWords: 10 }, { maxWords: 8 });

      const over = await saveReportCard(asTeacher, classId, words(11));
      expect(over.status).toBe(400);
      expect(over.body).toMatchObject({ code: 'COMMENT_TOO_LONG', maxWords: 10, studentIds: [studentId] });
      expect(await savedReportCard()).toBeNull();

      expect((await saveReportCard(asTeacher, classId, words(10))).status).toBe(200);
      expect((await saveReportCard(asTeacher, classId, words(2))).status).toBe(200);
      expect(await savedReportCard()).toBe(words(2));
      expect((await saveReportCard(asTeacher, classId, '')).status).toBe(200);

      // The maximum is for everyone, and each document has its own.
      expect((await saveReportCard(asAdmin, classId, words(11))).status).toBe(400);
      expect((await saveProgress(asTeacher, classId, words(9))).status).toBe(400);
      expect((await saveProgress(asTeacher, classId, words(8))).status).toBe(200);
      const single = await asTeacher('post', `/api/progress-reports/feedback/student/${studentId}/class/${classId}`).send({ comment: words(9) });
      expect(single.status).toBe(400);
      expect(single.body.code).toBe('COMMENT_TOO_LONG');
    });

    it('fail the whole batch when one comment is over the maximum', async () => {
      await setLimits({ maxWords: 10 });
      const res = await asTeacher('post', '/api/report-cards/feedback/bulk').send({
        feedbackEntries: [
          { studentId, classId, comment: words(3) },
          { studentId: otherStudentId, classId, comment: words(12) },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.studentIds).toEqual([otherStudentId]);
      expect(await savedReportCard()).toBeNull();
    });

    it('let a comment saved before the limit be sent again unchanged, but not changed and still too long', async () => {
      await saveReportCard(asTeacher, classId, words(30));
      await setLimits({ maxWords: 10 });

      const again = await asTeacher('post', '/api/report-cards/feedback/bulk')
        .send({ feedbackEntries: [{ studentId, classId, workHabits: 'E', behavior: 'G', comment: words(30) }] });
      expect(again.status).toBe(200);
      const { rows } = await pool.query('SELECT work_habits, comment FROM report_card_feedback WHERE class_id = $1 AND student_id = $2', [classId, studentId]);
      expect(rows[0]).toEqual({ work_habits: 'E', comment: words(30) });

      expect((await saveReportCard(asTeacher, classId, words(29))).status).toBe(400);
      expect((await saveReportCard(asTeacher, classId, words(10))).status).toBe(200);
    });

    it('count a comment under the minimum as not finished in the comments status', async () => {
      await saveReportCard(asTeacher, classId, words(3));
      await saveReportCard(asTeacher, otherClassId, words(6));
      const status = async () => (await asAdmin('get', '/api/report-cards/comments-status?term=Term 1')).body.data.find((s) => s.studentId === studentId);

      expect(await status()).toMatchObject({ total: 2, complete: 2 });
      await setLimits({ minWords: 5 });
      const after = await status();
      expect(after).toMatchObject({ total: 2, complete: 1 });
      expect(after.missing.map((m) => m.subject)).toEqual(['Math']);
    });
  });

  describe('locking a whole term', () => {
    it('stops a teacher on every write path and keeps what was saved', async () => {
      await saveReportCard(asTeacher, classId, 'Before the lock.');
      await saveProgress(asTeacher, classId, 'Before the lock.');
      expect((await lockTerm('report_card')).status).toBe(200);
      expect((await lockTerm('progress_report')).status).toBe(200);

      const refused = [
        await saveReportCard(asTeacher, classId, 'After the lock.'),
        await asTeacher('post', '/api/report-cards/feedback').send({ studentId, classId, comment: 'After the lock.' }),
        await saveProgress(asTeacher, classId, 'After the lock.'),
        await asTeacher('post', `/api/progress-reports/feedback/student/${studentId}/class/${classId}`).send({ comment: 'After the lock.' }),
        await asTeacher('put', `/api/progress-reports/feedback/student/${studentId}/class/${classId}`).send({ comment: 'After the lock.' }),
        await asTeacher('delete', `/api/progress-reports/feedback/student/${studentId}/class/${classId}?term=Term 1`),
      ];
      expect(refused.map((r) => [r.status, r.body.code])).toEqual(Array(6).fill([409, 'COMMENTS_LOCKED']));
      expect(await savedReportCard()).toBe('Before the lock.');
      expect(await savedProgress()).toBe('Before the lock.');

      const rules = await classRules();
      expect(rules.reportCard).toMatchObject({ locked: true, lockScope: 'term' });
      expect(rules.progressReport).toMatchObject({ locked: true, lockScope: 'term' });
    });

    it('is not dodged by another spelling of the class id', async () => {
      await saveReportCard(asTeacher, classId, 'Before the lock.');
      await lockTerm('report_card');
      await lockTerm('progress_report');

      for (const spelling of [classId.toUpperCase(), `{${classId}}`, classId.replace(/-/g, '')]) {
        const tries = [
          await asTeacher('post', '/api/report-cards/feedback').send({ studentId, classId: spelling, comment: 'Slipped past.' }),
          await saveReportCard(asTeacher, spelling, 'Slipped past.'),
          await saveProgress(asTeacher, spelling, 'Slipped past.'),
          await asTeacher('post', `/api/progress-reports/feedback/student/${studentId}/class/${encodeURIComponent(spelling)}`).send({ comment: 'Slipped past.' }),
        ];
        // Refused one way or another (locked, or the id is not accepted at all): never saved.
        expect([spelling, tries.map((r) => r.status >= 400)]).toEqual([spelling, [true, true, true, true]]);
      }
      expect(await savedReportCard()).toBe('Before the lock.');
      expect(await savedProgress()).toBeNull();
    });

    it('holds the maximum against another spelling of the ids too', async () => {
      await setLimits({ maxWords: 5 });
      const res = await asTeacher('post', '/api/report-cards/feedback')
        .send({ studentId: studentId.toUpperCase(), classId: classId.toUpperCase(), comment: words(9) });
      expect([res.status, res.body.code]).toEqual([400, 'COMMENT_TOO_LONG']);
      const notText = await asTeacher('post', '/api/report-cards/feedback').send({ studentId, classId, comment: [words(9)] });
      expect([notText.status, notText.body.code]).toEqual([400, 'INVALID_COMMENT_ENTRY']);
      expect(await savedReportCard()).toBeNull();

      // The saved comment sent again, ids in upper case: still recognised as unchanged.
      await pool.query(`INSERT INTO report_card_feedback (student_id, class_id, term, comment) VALUES ($1, $2, 'Term 1', $3)`, [studentId, classId, words(9)]);
      const again = await asTeacher('post', '/api/report-cards/feedback')
        .send({ studentId: studentId.toUpperCase(), classId: classId.toUpperCase(), workHabits: 'E', comment: words(9) });
      expect(again.status).toBe(200);
    });

    it('locks each document on its own', async () => {
      await lockTerm('report_card');
      expect((await saveReportCard(asTeacher, classId, 'x')).status).toBe(409);
      expect((await saveProgress(asTeacher, classId, 'Still open.')).status).toBe(200);
    });

    it('lets a reviewer keep editing, and reopens for teachers', async () => {
      await lockTerm('report_card');
      expect((await saveReportCard(asAdmin, classId, 'Fixed by the office.')).status).toBe(200);
      expect(await savedReportCard()).toBe('Fixed by the office.');

      await lockTerm('report_card', false);
      expect((await saveReportCard(asTeacher, classId, 'Open again.')).status).toBe(200);
      expect((await classRules()).reportCard).toMatchObject({ locked: false, lockScope: null });
    });

    it('is refused for a teacher, for another kind and for an unknown term', async () => {
      expect((await asTeacher('put', '/api/report-comments/locks/term').send({ termId, kind: 'report_card', locked: true })).status).toBe(403);
      expect((await asAdmin('put', '/api/report-comments/locks/term').send({ termId, kind: 'homework', locked: true })).status).toBe(400);
      expect((await asAdmin('put', '/api/report-comments/locks/term').send({ termId, kind: 'report_card', locked: 'yes' })).status).toBe(400);
      const unknown = await asAdmin('put', '/api/report-comments/locks/term')
        .send({ termId: '00000000-0000-4000-8000-000000000000', kind: 'report_card', locked: true });
      expect(unknown.status).toBe(404);
    });
  });

  describe("a class's exception", () => {
    it('locks one class while the term is open', async () => {
      expect((await lockClass(classId, 'report_card', true)).body.data).toMatchObject({ locked: true, lockScope: 'class' });
      expect((await saveReportCard(asTeacher, classId, 'x')).status).toBe(409);
      expect((await saveReportCard(asTeacher, otherClassId, 'The other class is open.')).status).toBe(200);
      expect((await saveProgress(asTeacher, classId, 'The other document is open.')).status).toBe(200);
    });

    it('reopens one class while the term is locked', async () => {
      await lockTerm('report_card');
      expect((await lockClass(classId, 'report_card', false)).body.data).toMatchObject({ locked: false, lockScope: 'class' });
      expect((await saveReportCard(asTeacher, classId, 'Reopened for a correction.')).status).toBe(200);
      expect((await saveReportCard(asTeacher, otherClassId, 'x')).status).toBe(409);
    });

    it('goes away when it matches the term again, and when the whole term is locked or reopened', async () => {
      const exceptions = async () => (await pool.query('SELECT class_id, locked FROM report_comment_class_locks')).rows;

      await lockClass(classId, 'report_card', true);
      expect(await exceptions()).toEqual([{ class_id: classId, locked: true }]);
      await lockClass(classId, 'report_card', false); // the term is open: nothing left to say
      expect(await exceptions()).toEqual([]);

      await lockTerm('report_card');
      await lockClass(classId, 'report_card', false);
      expect(await exceptions()).toEqual([{ class_id: classId, locked: false }]);
      await lockTerm('report_card'); // lock everything again
      expect(await exceptions()).toEqual([]);
      expect((await saveReportCard(asTeacher, classId, 'x')).status).toBe(409);

      await lockClass(otherClassId, 'report_card', false);
      await lockTerm('report_card', false); // reopen everything
      expect(await exceptions()).toEqual([]);
      expect((await saveReportCard(asTeacher, classId, 'Open.')).status).toBe(200);
    });

    it('is refused for a class of another school and for a teacher', async () => {
      const { rows } = await pool.query(
        `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
         VALUES ('PLAYGROUND', '5', 'Math', 'Elsewhere', $1, NULL, NULL) RETURNING class_id`,
        [TEACHER_ID],
      );
      expect((await lockClass(rows[0].class_id, 'report_card', true)).status).toBe(404);
      expect((await asTeacher('put', '/api/report-comments/locks/class').send({ classId, kind: 'report_card', locked: true })).status).toBe(403);
    });
  });

  describe('JK and SK', () => {
    let jkClassId;
    let jkStudentId;
    let domainId;
    const saveDomain = (as, comment) => as('post', '/api/jk/domain-comments/bulk')
      .send({ entries: [{ studentId: jkStudentId, domainId, term: 'Term 1', comment, school: 'ALHAADIACADEMY' }] });
    const saveJkProgress = (as, comment) => as('post', '/api/jk/progress-report-comments/bulk')
      .send({ entries: [{ studentId: jkStudentId, term: 'Term 1', sectionType: 'academic_achievement', comment, school: 'ALHAADIACADEMY' }] });
    const savedDomain = async () => (await pool.query('SELECT comment FROM jk_domain_comments WHERE student_id = $1', [jkStudentId])).rows[0]?.comment ?? null;

    beforeEach(async () => {
      const { rows: cls } = await pool.query(
        `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, term_id, term_name)
         VALUES ('ALHAADIACADEMY', 'JK', 'Homeroom', 'Teacher One', $1, $2, 'Term 1') RETURNING class_id`,
        [TEACHER_ID, termId],
      );
      jkClassId = cls[0].class_id;
      const { rows: stu } = await pool.query(`INSERT INTO students (name, school, grade) VALUES ('Jana', 'ALHAADIACADEMY', 'JK') RETURNING student_id`);
      jkStudentId = stu[0].student_id;
      await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [jkClassId, jkStudentId]);
      const { rows: dom } = await pool.query(
        `INSERT INTO jk_skill_domains (document_type, name, school) VALUES ('report_card', 'Language', 'ALHAADIACADEMY') RETURNING domain_id`,
      );
      domainId = dom[0].domain_id;
    });

    it('lock with the whole term, each document on its own, and a reviewer still edits', async () => {
      expect((await saveDomain(asTeacher, 'Before the lock.')).status).toBe(200);
      await lockTerm('report_card');

      const refused = await saveDomain(asTeacher, 'After the lock.');
      expect([refused.status, refused.body.code]).toEqual([409, 'COMMENTS_LOCKED']);
      expect(await savedDomain()).toBe('Before the lock.');
      expect((await saveJkProgress(asTeacher, 'Progress comments are open.')).status).toBe(200);
      expect((await saveDomain(asAdmin, 'Fixed by the office.')).status).toBe(200);

      await lockTerm('progress_report');
      expect((await saveJkProgress(asTeacher, 'x')).status).toBe(409);
      await lockTerm('report_card', false);
      expect((await saveDomain(asTeacher, 'Open again.')).status).toBe(200);
    });

    it('let a whole-document save through when it only repeats the saved comment', async () => {
      await saveDomain(asTeacher, 'Before the lock.');
      await lockTerm('report_card');

      // The JK page sends the comments with every rating change.
      expect((await saveDomain(asTeacher, 'Before the lock.')).status).toBe(200);
      expect((await saveDomain(asTeacher, 'Before the lock. And more.')).status).toBe(409);
      expect((await saveDomain(asTeacher, '')).status).toBe(409);
      expect(await savedDomain()).toBe('Before the lock.');
    });

    it('hold SK subject comments with either document locked', async () => {
      const { rows: subject } = await pool.query(
        `INSERT INTO sk_subjects (document_type, name, school) VALUES ('report_card', 'Language', 'ALHAADIACADEMY') RETURNING subject_id`,
      );
      const saveSubject = (as, comment) => as('post', '/api/sk/subject-comments/bulk')
        .send({ entries: [{ studentId: jkStudentId, subjectId: subject[0].subject_id, term: 'Term 1', comment, school: 'ALHAADIACADEMY' }] });

      expect((await saveSubject(asTeacher, 'Before the lock.')).status).toBe(200);
      await lockTerm('progress_report');
      expect((await saveSubject(asTeacher, 'Changed.')).status).toBe(409);
      expect((await saveSubject(asTeacher, 'Before the lock.')).status).toBe(200);
      await lockTerm('progress_report', false);
      await lockTerm('report_card');
      expect((await saveSubject(asTeacher, 'Changed.')).status).toBe(409);
      await lockTerm('report_card', false);
      expect((await saveSubject(asTeacher, 'Changed.')).status).toBe(200);
    });

    it('follow the term on the class page, are never word-limited, and take no exception', async () => {
      await setLimits({ minWords: 5, maxWords: 10 });
      await lockTerm('report_card');
      const rules = await classRules(asTeacher, jkClassId);
      expect(rules.reportCard).toEqual({ locked: true, lockScope: 'term', minWords: null, maxWords: null });

      const res = await lockClass(jkClassId, 'report_card', false);
      expect([res.status, res.body.code]).toEqual([400, 'KINDERGARTEN_FOLLOWS_TERM']);
      expect((await classRules(asTeacher, jkClassId)).reportCard.locked).toBe(true);
    });
  });

  describe('the review overview', () => {
    it('lists the term, its locks and how each class stands', async () => {
      await setLimits({ minWords: 5, maxWords: 10 });
      await saveReportCard(asTeacher, classId, words(6));                 // fine
      await saveReportCard(asTeacher, classId, words(2), otherStudentId); // under the minimum
      await pool.query(
        `INSERT INTO report_card_feedback (student_id, class_id, term, comment) VALUES ($1, $2, 'Term 1', $3)`,
        [studentId, otherClassId, words(14)],                             // saved before the maximum
      );
      await lockTerm('report_card');
      await lockClass(otherClassId, 'report_card', false);

      const res = await asAdmin('get', '/api/report-comments/overview');
      expect(res.status).toBe(200);
      const { limits, term, termLocks, classes } = res.body.data;
      expect(limits.reportCard).toEqual({ minWords: 5, maxWords: 10 });
      expect(term).toMatchObject({ termId, name: 'Term 1', isActive: true });
      expect(termLocks.reportCard).toMatchObject({ locked: true, lockedBy: 'Ada Admin' });
      expect(termLocks.progressReport).toEqual({ locked: false, lockedAt: null, lockedBy: null });

      const math = classes.find((c) => c.classId === classId);
      expect(math).toMatchObject({ subject: 'Math', grade: '5', teacherName: 'Teacher One', kindergarten: false });
      expect(math.reportCard).toEqual({ locked: true, exception: null, students: 2, written: 2, tooShort: 1, tooLong: 0 });
      expect(math.progressReport).toEqual({ locked: false, exception: null, students: 2, written: 0, tooShort: 0, tooLong: 0 });
      const science = classes.find((c) => c.classId === otherClassId);
      expect(science.reportCard).toEqual({ locked: false, exception: 'open', students: 1, written: 1, tooShort: 0, tooLong: 1 });

      expect((await asAdmin('get', `/api/report-comments/overview?termId=${termId}`)).body.data.classes).toHaveLength(2);
      expect((await asAdmin('get', '/api/report-comments/overview?termId=nope')).status).toBe(400);
      expect((await asTeacher('get', '/api/report-comments/overview')).status).toBe(403);
    });
  });
});
