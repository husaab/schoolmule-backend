// Report cards and progress reports: staff own every route; a parent may only
// list and open the files of a child they are linked to, and nobody can mint a
// signed URL for a storage path that is not one of their school's report rows.

const db = require('../../../config/database'); // mapped to the mock
const { authenticatedRequest } = require('../../helpers/testApp');
const { mockParentUser, mockTeacherUser, TEST_PARENT_USER_ID, TEST_SCHOOL } = require('../../helpers/mockAuth');

const STUDENT = '77777777-7777-4777-8777-777777777777';
const PATH = 'ALHAADIACADEMY/John_Smith_Term_1_report_card.pdf';

describe('report-card and progress-report routes', () => {
  beforeEach(() => db._reset());

  describe('staff-only routes refuse a parent', () => {
    it.each([
      ['post', '/api/report-cards/generate'],
      ['post', '/api/report-cards/feedback'],
      ['get', '/api/report-cards/feedback'],
      ['get', '/api/report-cards/view'],
      ['delete', '/api/report-cards/delete'],
      ['post', '/api/report-cards/delete/bulk'],
      ['post', '/api/progress-reports/generate'],
      ['post', '/api/progress-reports/reports'],
      ['get', `/api/progress-reports/feedback/student/${STUDENT}`],
      ['get', '/api/progress-reports/reports/term/Term%201/school/ALHAADIACADEMY'],
      ['delete', '/api/progress-reports/delete'],
    ])('%s %s → 403 for a parent', async (method, url) => {
      const res = await authenticatedRequest(method, url, mockParentUser()).send({});
      expect(res.status).toBe(403);
      expect(db.query).not.toHaveBeenCalledWith(expect.stringMatching(/report_cards|progress_reports/), expect.anything());
    });
  });

  describe("GET /api/report-cards/view/student", () => {
    const url = `/api/report-cards/view/student?studentId=${STUDENT}&term=Term%201&school=PLAYGROUND`;

    it('lets a parent list a linked child and scopes the school to the token, not the query', async () => {
      db.query.mockResolvedValueOnce({ rows: [{ parent_student_link_id: 'link' }] }); // link check
      db.query.mockResolvedValueOnce({ rows: [{ file_path: PATH }] });                // report cards
      const res = await authenticatedRequest('get', url, mockParentUser());
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ file_path: PATH }]);
      const linkCall = db.query.mock.calls.find(([sql]) => /FROM parent_students/.test(sql));
      expect(linkCall[1]).toEqual([STUDENT, TEST_PARENT_USER_ID]);
      const listCall = db.query.mock.calls.find(([sql]) => /FROM report_cards/.test(sql));
      expect(listCall[1]).toEqual([STUDENT, 'Term 1', TEST_SCHOOL]);
    });

    it('refuses a parent who is not linked to the student', async () => {
      db.query.mockResolvedValueOnce({ rows: [] }); // link check
      const res = await authenticatedRequest('get', url, mockParentUser());
      expect(res.status).toBe(403);
      expect(db.query).not.toHaveBeenCalledWith(expect.stringMatching(/FROM report_cards/), expect.anything());
    });

    it('lets staff list any student of their school without a link check', async () => {
      db.query.mockResolvedValueOnce({ rows: [] }); // report cards
      const res = await authenticatedRequest('get', url, mockTeacherUser());
      expect(res.status).toBe(200);
      expect(db.query).not.toHaveBeenCalledWith(expect.stringMatching(/FROM parent_students/), expect.anything());
      const listCall = db.query.mock.calls.find(([sql]) => /FROM report_cards/.test(sql));
      expect(listCall[1]).toEqual([STUDENT, 'Term 1', TEST_SCHOOL]);
    });
  });

  describe('GET /api/progress-reports/reports/student/:studentId', () => {
    const url = `/api/progress-reports/reports/student/${STUDENT}`;

    it('lets a parent list a linked child', async () => {
      db.query.mockResolvedValueOnce({ rows: [{ parent_student_link_id: 'link' }] });
      db.query.mockResolvedValueOnce({ rows: [{ file_path: PATH }] });
      const res = await authenticatedRequest('get', url, mockParentUser());
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ file_path: PATH }]);
    });

    it('refuses a parent who is not linked to the student', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });
      const res = await authenticatedRequest('get', url, mockParentUser());
      expect(res.status).toBe(403);
    });
  });

  describe.each([
    ['report-cards', 'report_cards'],
    ['progress-reports', 'progress_reports'],
  ])('GET /api/%s/signed-url', (prefix, table) => {
    const url = `/api/${prefix}/signed-url?path=${encodeURIComponent(PATH)}`;
    const ownershipCall = () => db.query.mock.calls.find(([sql]) => new RegExp(`FROM ${table}`).test(sql));

    it('signs a path that is one of the school\'s report rows for staff', async () => {
      db.query.mockResolvedValueOnce({ rows: [{ ok: 1 }] });
      const res = await authenticatedRequest('get', url, mockTeacherUser());
      expect(res.status).toBe(200);
      expect(res.body.url).toBe('https://mock-signed-url.com');
      const [, params] = ownershipCall();
      expect(params.slice(0, 2)).toEqual([PATH, TEST_SCHOOL]);
    });

    it('refuses staff a path that is not a report row of their school', async () => {
      db.query.mockResolvedValueOnce({ rows: [] });
      const res = await authenticatedRequest('get', url, mockTeacherUser());
      expect(res.status).toBe(403);
    });

    it("signs a path only when it belongs to one of the parent's linked children", async () => {
      db.query.mockResolvedValueOnce({ rows: [{ ok: 1 }] });
      const ok = await authenticatedRequest('get', url, mockParentUser());
      expect(ok.status).toBe(200);
      const [sql, params] = ownershipCall();
      expect(sql).toMatch(/parent_students/);
      expect(params).toEqual([PATH, TEST_SCHOOL, TEST_PARENT_USER_ID]);

      db._reset();
      db.query.mockResolvedValueOnce({ rows: [] });
      const refused = await authenticatedRequest('get', url, mockParentUser());
      expect(refused.status).toBe(403);
    });

    it('still 400s on a missing path before touching the database', async () => {
      const res = await authenticatedRequest('get', `/api/${prefix}/signed-url`, mockParentUser());
      expect(res.status).toBe(400);
      expect(ownershipCall()).toBeUndefined();
    });
  });
});
