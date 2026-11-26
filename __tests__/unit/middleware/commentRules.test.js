// The comment guards in front of the save routes: a locked class refuses a
// teacher (409 COMMENTS_LOCKED) and lets a reviewer through; a changed comment
// over the maximum is refused (400 COMMENT_TOO_LONG) for everyone.

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, TEST_TEACHER_USER_ID } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const db = require('../../__mocks__/config/database');

const app = getApp();
const CLASS_ID = '11111111-1111-4111-8111-111111111111';
const S1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const S2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';

// requireGradebookAccess: the teacher teaches the class.
const mockGradebookGuard = () => mockQueryResponse([{
  class_id: CLASS_ID, school: 'ALHAADIACADEMY', teacher_id: TEST_TEACHER_USER_ID,
  is_co_teacher: false, classes_found: 99, assessments_found: 99,
}]);

const rule = (over = {}) => ({
  ord: 1, class_id: CLASS_ID, school: 'ALHAADIACADEMY', grade: '5', term_id: 't1', kind: 'report_card',
  locked: false, lock_scope: null, min_words: null, max_words: null, ...over,
});
const mockRules = (...rows) => db.query.mockCommentRulesResponseOnce({ rows });
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const wrote = () => db.query.mock.calls.some(([sql]) => /INSERT INTO (report_card|progress_report)_feedback/.test(sql));

describe('comment guards: the review lock', () => {
  it('refuses a teacher saving into a locked class and writes nothing', async () => {
    mockGradebookGuard();
    mockRules(rule({ locked: true, lock_scope: 'term' }));

    const res = await request(app)
      .post('/api/report-cards/feedback/bulk')
      .set(auth(mockTeacherUser()))
      .send({ feedbackEntries: [{ studentId: S1, classId: CLASS_ID, comment: 'Good term.' }] });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ status: 'failed', code: 'COMMENTS_LOCKED' });
    expect(res.body.message).toMatch(/Report card comments are locked/);
    expect(wrote()).toBe(false);
  });

  it('checks each entry against the rules found for it, by position', async () => {
    mockGradebookGuard();
    // Two entries: the first class is open, the second is locked.
    mockRules(rule({ ord: 1 }), rule({ ord: 2, locked: true, lock_scope: 'class' }));

    const res = await request(app)
      .post('/api/report-cards/feedback/bulk')
      .set(auth(mockTeacherUser()))
      .send({ feedbackEntries: [
        { studentId: S1, classId: CLASS_ID, comment: 'Open class.' },
        { studentId: S2, classId: CLASS_ID.toUpperCase(), comment: 'Locked class.' },
      ] });

    expect(res.status).toBe(409);
    expect(wrote()).toBe(false);
    // The ids go to the database as they were sent: it decides which class each names.
    const lookup = db.query.mock.calls.find(([sql]) => /WITH ORDINALITY AS r\(class_id, ord\)/.test(sql));
    expect(lookup[1]).toEqual([[CLASS_ID, CLASS_ID.toUpperCase()], ['report_card']]);
  });

  it('refuses the write when the rules of a class could not be found', async () => {
    mockGradebookGuard();
    mockRules(); // no row for the class

    const res = await request(app)
      .post('/api/report-cards/feedback')
      .set(auth(mockTeacherUser()))
      .send({ studentId: S1, classId: CLASS_ID, comment: 'Unchecked.' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_COMMENT_ENTRY');
    expect(wrote()).toBe(false);
  });

  it('lets a holder of school_setup save into a locked class', async () => {
    mockGradebookGuard();
    mockRules(rule({ locked: true, lock_scope: 'term' }));
    mockQueryResponse([{ term: 'Term 1' }]); // resolveClassTerm

    const res = await request(app)
      .post('/api/report-cards/feedback/bulk')
      .set(auth(mockAdminUser()))
      .send({ feedbackEntries: [{ studentId: S1, classId: CLASS_ID, comment: 'Fixed a typo.' }] });

    expect(res.status).toBe(200);
    expect(wrote()).toBe(true);
  });

  it('refuses a teacher deleting progress feedback from a locked class', async () => {
    mockGradebookGuard();
    mockRules(rule({ kind: 'progress_report', locked: true, lock_scope: 'class' }));

    const res = await request(app)
      .delete(`/api/progress-reports/feedback/student/${S1}/class/${CLASS_ID}`)
      .set(auth(mockTeacherUser()))
      .query({ term: 'Term 1' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COMMENTS_LOCKED');
    expect(res.body.message).toMatch(/Progress report comments are locked/);
    expect(db.query.mock.calls.some(([sql]) => /DELETE FROM progress_report_feedback/.test(sql))).toBe(false);
  });
});

describe('comment guards: the maximum words', () => {
  it('refuses a comment over the maximum, saying the limit and whose it is', async () => {
    mockGradebookGuard();
    mockRules(rule({ ord: 1, max_words: 5 }), rule({ ord: 2, max_words: 5 }));
    mockQueryResponse([]); // nothing saved yet for the student

    const res = await request(app)
      .post('/api/report-cards/feedback/bulk')
      .set(auth(mockAdminUser()))
      .send({ feedbackEntries: [
        { studentId: S1, classId: CLASS_ID, comment: words(6) },
        { studentId: S2, classId: CLASS_ID, comment: words(5) },
      ] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 'failed', code: 'COMMENT_TOO_LONG', maxWords: 5, studentIds: [S1] });
    expect(res.body.message).toBe('A comment can be at most 5 words. Shorten it to save.');
    expect(wrote()).toBe(false);
  });

  it('refuses a comment that is not text, which would be stored uncounted', async () => {
    for (const comment of [[words(50)], { text: words(50) }, 12345]) {
      mockGradebookGuard();
      mockRules(rule({ max_words: 5 }));

      const res = await request(app)
        .post('/api/report-cards/feedback/bulk')
        .set(auth(mockTeacherUser()))
        .send({ feedbackEntries: [{ studentId: S1, classId: CLASS_ID, comment }] });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'INVALID_COMMENT_ENTRY', message: 'A comment must be text.' });
      expect(wrote()).toBe(false);
      db._reset();
    }
  });

  it('lets an over-long comment through when it is the saved one sent again', async () => {
    mockGradebookGuard();
    mockRules(rule({ max_words: 5 }));
    mockQueryResponse([{ ord: 1, comment: words(9) }]); // saved before the limit
    mockQueryResponse([{ term: 'Term 1' }]); // resolveClassTerm

    const res = await request(app)
      .post('/api/report-cards/feedback/bulk')
      .set(auth(mockTeacherUser()))
      .send({ feedbackEntries: [{ studentId: S1, classId: CLASS_ID, workHabits: 'G', comment: words(9) }] });

    expect(res.status).toBe(200);
    expect(wrote()).toBe(true);
  });

  it('never looks at saved comments when nothing is over the maximum', async () => {
    mockGradebookGuard();
    mockRules(rule({ min_words: 20, max_words: 50 }));
    mockQueryResponse([{ term: 'Term 1' }]); // resolveClassTerm

    const res = await request(app)
      .post('/api/report-cards/feedback')
      .set(auth(mockTeacherUser()))
      .send({ studentId: S1, classId: CLASS_ID, comment: 'Short, under the minimum, still a draft.' });

    // Under the minimum still saves.
    expect(res.status).toBe(200);
    expect(db.query.mock.calls.some(([sql]) => /FROM unnest\(\$1::uuid\[\], \$2::uuid\[\]\) AS e\(student_id, class_id\)/.test(sql))).toBe(false);
  });

  it('answers 500 when the rules cannot be read, and writes nothing', async () => {
    mockGradebookGuard();
    db.query.mockCommentRulesRejectionOnce(new Error('db down'));

    const res = await request(app)
      .post('/api/report-cards/feedback')
      .set(auth(mockTeacherUser()))
      .send({ studentId: S1, classId: CLASS_ID, comment: 'x' });

    expect(res.status).toBe(500);
    expect(wrote()).toBe(false);
  });
});
