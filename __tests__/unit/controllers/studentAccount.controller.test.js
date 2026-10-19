jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const { authenticatedRequest } = require('../../helpers/testApp');
const { mockTeacherUser, mockParentUser } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const db = require('../../__mocks__/config/database');

const STUDENT_ID = '7c0d1a52-3f7e-4c55-9d2e-0a4b6c8e1f20';
const OTHER_ID = '7c0d1a52-3f7e-4c55-9d2e-0a4b6c8e1f21';

// Only the global resolveSchoolYear lookup may reach the database: a
// validation failure must answer before any student or account query runs.
const onlyYearLookups = () =>
  db.query.mock.calls.every(([sql]) => typeof sql === 'string' && sql.includes('FROM school_years'));

const VALID_SETTINGS = {
  enabled: true,
  loginFromGrade: '1',
  qrUntilGrade: '3',
  studentEmailFromGrade: '1',
  parentsReadPrivateComments: true,
  summaryDow: 5,
  studentPhotos: false,
  consentNoticeVersion: '2026-10',
};

describe('POST /api/admin/student-accounts/invite', () => {
  it('400s without consentConfirmed', async () => {
    const res = await authenticatedRequest('post', '/api/admin/student-accounts/invite')
      .send({ studentIds: [STUDENT_ID] });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      status: 'failed',
      message: 'Confirm you have parental consent before inviting students',
    });
    expect(onlyYearLookups()).toBe(true);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('400s when consentConfirmed is truthy but not true', async () => {
    const res = await authenticatedRequest('post', '/api/admin/student-accounts/invite')
      .send({ studentIds: [STUDENT_ID], consentConfirmed: 'yes' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Confirm you have parental consent before inviting students');
  });

  it('400s when studentIds is empty', async () => {
    const res = await authenticatedRequest('post', '/api/admin/student-accounts/invite')
      .send({ studentIds: [], consentConfirmed: true });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(onlyYearLookups()).toBe(true);
  });

  it('400s when studentIds has more than 200 entries', async () => {
    const ids = Array.from({ length: 201 }, (_, i) =>
      `7c0d1a52-3f7e-4c55-9d2e-${String(i).padStart(12, '0')}`);
    const res = await authenticatedRequest('post', '/api/admin/student-accounts/invite')
      .send({ studentIds: ids, consentConfirmed: true });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(onlyYearLookups()).toBe(true);
  });

  it('400s when a student id is not a uuid', async () => {
    const res = await authenticatedRequest('post', '/api/admin/student-accounts/invite')
      .send({ studentIds: [STUDENT_ID, 'not-a-uuid'], consentConfirmed: true });

    expect(res.status).toBe(400);
    expect(onlyYearLookups()).toBe(true);
  });

  it('400s on a notice version longer than 40 characters', async () => {
    const res = await authenticatedRequest('post', '/api/admin/student-accounts/invite')
      .send({ studentIds: [STUDENT_ID, OTHER_ID], consentConfirmed: true, noticeVersion: 'x'.repeat(41) });

    expect(res.status).toBe(400);
    expect(onlyYearLookups()).toBe(true);
  });
});

describe('PATCH /api/admin/student-accounts/:studentId', () => {
  it('rejects a malformed email (400)', async () => {
    const res = await authenticatedRequest('patch', `/api/admin/student-accounts/${STUDENT_ID}`)
      .send({ studentEmail: 'amal.haddad@' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(onlyYearLookups()).toBe(true);
  });

  it('400s when studentEmail is missing from the body', async () => {
    const res = await authenticatedRequest('patch', `/api/admin/student-accounts/${STUDENT_ID}`).send({});

    expect(res.status).toBe(400);
    expect(onlyYearLookups()).toBe(true);
  });

  it('404s a malformed student id before touching the database', async () => {
    const res = await authenticatedRequest('patch', '/api/admin/student-accounts/not-a-uuid')
      .send({ studentEmail: 'amal.haddad@example.com' });

    expect(res.status).toBe(404);
    expect(onlyYearLookups()).toBe(true);
  });
});

describe('PUT /api/admin/classroom-settings', () => {
  it("rejects loginFromGrade 'K' (400)", async () => {
    const res = await authenticatedRequest('put', '/api/admin/classroom-settings')
      .send({ ...VALID_SETTINGS, loginFromGrade: 'K' });

    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
    expect(onlyYearLookups()).toBe(true);
  });

  it.each([
    ['summaryDow 7', { summaryDow: 7 }],
    ['a fractional summaryDow', { summaryDow: 2.5 }],
    ['a missing field', { studentPhotos: undefined }],
    ['a non-boolean enabled', { enabled: 'true' }],
    ['an empty notice version', { consentNoticeVersion: '  ' }],
    ['an unknown qrUntilGrade', { qrUntilGrade: '9' }],
  ])('rejects %s (400)', async (_label, patch) => {
    const res = await authenticatedRequest('put', '/api/admin/classroom-settings')
      .send({ ...VALID_SETTINGS, ...patch });

    expect(res.status).toBe(400);
    expect(onlyYearLookups()).toBe(true);
  });

  it('saves a valid body with student email turned off and returns camelCase settings', async () => {
    mockQueryResponse([{
      school: 'ALHAADIACADEMY',
      enabled: true,
      login_from_grade: '2',
      qr_until_grade: '3',
      student_email_from_grade: null,
      parents_read_private_comments: false,
      summary_dow: 4,
      student_photos: true,
      consent_notice_version: '2026-11',
      updated_at: new Date('2026-10-16T12:00:00Z'),
    }]);

    const res = await authenticatedRequest('put', '/api/admin/classroom-settings').send({
      ...VALID_SETTINGS,
      loginFromGrade: '2',
      studentEmailFromGrade: null,
      parentsReadPrivateComments: false,
      summaryDow: 4,
      studentPhotos: true,
      consentNoticeVersion: '2026-11',
      studentEmailDomains: [],
      studentSignIn: 'google_or_password',
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      enabled: true,
      loginFromGrade: '2',
      qrUntilGrade: '3',
      studentEmailFromGrade: null,
      parentsReadPrivateComments: false,
      summaryDow: 4,
      studentPhotos: true,
      consentNoticeVersion: '2026-11',
      studentEmailDomains: [],
      studentSignIn: 'google_or_password',
      updatedAt: '2026-10-16T12:00:00.000Z',
    });
  });
});

describe('admin only', () => {
  it.each([
    ['teacher', mockTeacherUser],
    ['parent', mockParentUser],
  ])('a %s token gets 403 on both routers', async (_label, token) => {
    const a = await authenticatedRequest('get', '/api/admin/student-accounts', token());
    const b = await authenticatedRequest('get', '/api/admin/classroom-settings', token());
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
  });
});
