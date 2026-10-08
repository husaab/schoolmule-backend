const db = require('../../../config/database'); // mapped to the mock by jest.unit.config
const requireAnnouncementAccess = require('../../../middleware/requireAnnouncementAccess');

const ID = '44444444-4444-4444-8444-444444444444';
const row = (over = {}) => ({
  announcement_id: ID, school: 'ALHAADIACADEMY', school_year_id: 'y1', scope: 'class', class_id: 'c1', grade: null,
  title: 'Forms', body: 'x', author_id: 't1', author_role: 'TEACHER', author_name: 'Ahmed Khan', published_at: '2026-10-08T12:00:00Z',
  pinned_until: null, is_pinned: false, edited_at: null, deleted_at: null, created_at: '2026-10-08T12:00:00Z',
  class_subject: 'Math', class_grade: '6', attachment_count: 0, is_author: false, is_guardian: false, is_class_teacher: false, ...over,
});
const run = (user, r, method = 'GET') => new Promise((resolve) => {
  const req = { params: { id: ID }, user, method };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn((b) => resolve({ req, body: b, status: res.status.mock.calls[0]?.[0] })) };
  db.query.mockResolvedValueOnce({ rows: r ? [r] : [] });
  requireAnnouncementAccess(req, res, () => resolve({ req, next: true }));
});
const parent = { userId: 'p1', role: 'PARENT', school: 'ALHAADIACADEMY' };
const teacher = { userId: 't2', role: 'TEACHER', school: 'ALHAADIACADEMY' };
const admin = { userId: 'a1', role: 'ADMIN', school: 'ALHAADIACADEMY' };

describe('requireAnnouncementAccess', () => {
  beforeEach(() => db._reset());

  it('404s an unknown id and another school', async () => {
    expect((await run(parent, null)).status).toBe(404);
    expect((await run(parent, row({ school: 'PLAYGROUND' }))).status).toBe(404);
  });

  it('lets a guardian in the audience through and refuses one outside it', async () => {
    const ok = await run(parent, row({ is_guardian: true }));
    expect(ok.next).toBe(true);
    expect(ok.req.announcement.classSubject).toBe('Math');
    expect((await run(parent, row({ is_guardian: false }))).status).toBe(403);
  });

  it('teacher: class/grade/school visibility flag or authorship', async () => {
    expect((await run(teacher, row({ is_class_teacher: true }))).next).toBe(true);
    expect((await run(teacher, row({ is_author: true }))).next).toBe(true);
    expect((await run(teacher, row())).status).toBe(403);
  });

  it('admin always passes; malformed id 403', async () => {
    expect((await run(admin, row())).next).toBe(true);
    db.query.mockRejectedValueOnce(new Error('invalid input syntax for type uuid'));
    const status = await new Promise((resolve) => {
      const r = { status: jest.fn().mockReturnThis(), json: jest.fn(() => resolve(r.status.mock.calls[0][0])) };
      requireAnnouncementAccess({ params: { id: 'nope' }, user: admin, method: 'GET' }, r, () => resolve('next'));
    });
    expect(status).toBe(403);
  });

  it('deleted: 410 with code REMOVED on GET, 404 otherwise', async () => {
    const g = await run(admin, row({ deleted_at: '2026-10-08T13:00:00Z' }));
    expect(g.status).toBe(410);
    expect(g.body.code).toBe('REMOVED');
    expect((await run(admin, row({ deleted_at: '2026-10-08T13:00:00Z' }), 'DELETE')).status).toBe(404);
  });
});
