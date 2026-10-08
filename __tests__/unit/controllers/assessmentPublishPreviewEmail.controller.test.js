const mockSend = jest.fn().mockResolvedValue({ data: { id: 'email_1' } });
jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: mockSend } })) }));

const db = require('../../../config/database'); // mapped to the mock by jest.unit.config
const { authenticatedRequest } = require('../../helpers/testApp');
const { mockTeacherUser, mockParentUser } = require('../../helpers/mockAuth');

const SCHOOL = 'ALHAADIACADEMY';
const TEACHER = '550e8400-e29b-41d4-a716-446655440001';
const CLASS = '22222222-2222-4222-8222-222222222222';
const A1 = '33333333-3333-4333-8333-333333333333';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '11111111-1111-4111-8111-222222222222';

const assessment = { assessment_id: A1, class_id: CLASS, name: 'Unit 3 Quiz', is_parent: false, parent_assessment_id: null, weight_points: 10, max_score: 20, sort_order: 1, is_published: false, parent_comment: null };

/** Each test declares the rows a query fragment returns; every call is recorded. */
function makeRouter(overrides = {}) {
  const calls = [];
  const defaults = {
    'AS is_co_teacher': [{ class_id: CLASS, school: SCHOOL, teacher_id: TEACHER, is_co_teacher: false }],
    'AND assessment_id = ANY($2::uuid[])': [assessment],
    'ORDER BY sort_order NULLS LAST, created_at': [assessment],
    'FROM class_students AS cs': [
      { student_id: S1, student_name: 'Amina Test', assessment_id: A1, score: 14, is_excluded: false },
      { student_id: S2, student_name: 'Bilal Test', assessment_id: A1, score: 17, is_excluded: false },
    ],
    'WHERE s.student_id = ANY($1::uuid[])': [
      { student_id: S1, student_name: 'Amina Test', guardian_emails: ['mom@example.com', 'dad@example.com'] },
      { student_id: S2, student_name: 'Bilal Test', guardian_emails: ['mom@example.com'] },
    ],
  };
  const table = [...Object.entries(overrides), ...Object.entries(defaults).filter(([k]) => !(k in overrides))];
  const impl = (sql, params) => {
    calls.push({ sql, params });
    for (const [frag, rows] of table) {
      if (sql.includes(frag)) return Promise.resolve({ rows, rowCount: rows.length });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  db.query.mockImplementation((sql, params) => {
    if (sql.includes('FROM school_years')) return Promise.resolve({ rows: [{ school_year_id: 'y1', school: SCHOOL, is_active: true }] });
    return impl(sql, params);
  });
  return { calls, ran: (frag) => calls.filter((c) => c.sql.includes(frag)) };
}

const post = (who = mockTeacherUser({ userId: TEACHER })) =>
  authenticatedRequest('post', `/api/assessment-publications/classes/${CLASS}/preview-email`, who);

describe('POST /api/assessment-publications/classes/:classId/preview-email', () => {
  beforeEach(() => { db._reset(); mockSend.mockClear(); });

  it('emails the teacher one digest as the first graded student\'s parent would get it, and logs nothing', async () => {
    const r = makeRouter();
    const res = await post().send({
      assessmentIds: [A1],
      batchComment: 'Great effort this week',
      assessmentComments: { [A1]: 'Watch the units' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sentTo: 'teacher@test.com', sampleStudentName: 'Amina Test', recipientCount: 2 });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const msg = mockSend.mock.calls[0][0];
    expect(msg.to).toEqual(['teacher@test.com']);
    expect(msg.subject).toMatch(/^\[Preview\] Amina Test/);
    expect(msg.html).toContain('Amina Test');
    expect(msg.html).toContain('Unit 3 Quiz');
    expect(msg.html).toContain('Great effort this week');
    expect(msg.html).toContain('Watch the units');

    expect(r.ran('INSERT INTO publication_emails')).toHaveLength(0);
    expect(r.ran('INSERT INTO publication_batches')).toHaveLength(0);
    expect(r.ran('UPDATE assessments')).toHaveLength(0);
  });

  it('400 when nobody has a score yet, so there is nothing to preview', async () => {
    makeRouter({ 'FROM class_students AS cs': [{ student_id: S1, student_name: 'Amina Test', assessment_id: A1, score: null, is_excluded: false }] });
    const res = await post().send({ assessmentIds: [A1] });
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('400 without assessmentIds; 403 for a parent', async () => {
    makeRouter();
    expect((await post().send({})).status).toBe(400);
    expect((await post(mockParentUser()).send({ assessmentIds: [A1] })).status).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
