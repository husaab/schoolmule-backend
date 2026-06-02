// Mock Resend so no real email is sent
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: {
      send: jest.fn().mockResolvedValue({ data: { id: 'email-123' }, error: null }),
    },
  })),
}));

// Mock the PDF generator so Puppeteer never launches in unit tests
jest.mock('../../../utils/pdfGenerator', () => ({
  createPDFBuffer: jest.fn().mockResolvedValue(Buffer.from('pdf')),
  createPDFBuffers: jest.fn((htmls) =>
    Promise.resolve((htmls || []).map(() => Buffer.from('pdf'))),
  ),
}));

// Mock the evaluator so we control which students "qualify"
jest.mock('../../../services/studentViewEvaluator', () => ({
  evaluateView: jest.fn(),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const { buildSchoolRow } = require('../../helpers/factories');
const { evaluateView } = require('../../../services/studentViewEvaluator');

const app = getApp();

const VIEW_ID = '11111111-1111-1111-1111-111111111111';
const url = `/api/student-views/${VIEW_ID}/email`;

const buildView = (overrides = {}) => ({
  view_id: VIEW_ID,
  school: TEST_SCHOOL,
  owner_user_id: null,
  name: 'Academic Excellence',
  description: 'Students with an overall average of 85% or higher.',
  is_shared: true,
  is_system: true,
  criteria: { termScope: 'active', thresholdPercent: 85, aggregationMode: 'overall_avg' },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

const buildEvaluated = (overrides = {}) => ({
  studentId: 's1',
  studentName: 'Alice Adams',
  grade: '5',
  homeroomTeacherId: null,
  perTerm: {},
  qualified: true,
  displayMetric: 91.234,
  ...overrides,
});

describe('POST /api/student-views/:viewId/email', () => {
  it('returns 400 when studentIds is missing', async () => {
    const token = mockAdminUser();
    const res = await request(app).post(url).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('failed');
  });

  it('returns 401 without an auth token', async () => {
    const res = await request(app).post(url).send({ studentIds: ['s1'] });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the view does not exist', async () => {
    const token = mockAdminUser();
    mockQueryResponse([]); // selectViewById -> none
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send({ studentIds: ['s1'] });
    expect(res.status).toBe(404);
  });

  it('returns 403 when the caller cannot access the view', async () => {
    const token = mockAdminUser();
    // Private, owned by someone else, not system -> forbidden
    mockQueryResponse([buildView({ is_system: false, is_shared: false, owner_user_id: 'someone-else' })]);
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send({ studentIds: ['s1'] });
    expect(res.status).toBe(403);
  });

  it('returns 400 when no selected students currently qualify', async () => {
    const token = mockAdminUser();
    mockQueryResponse([buildView()]); // selectViewById
    evaluateView.mockResolvedValue([]); // nobody qualifies
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send({ studentIds: ['s1'] });
    expect(res.status).toBe(400);
  });

  it('sends a certificate email and logs it on success', async () => {
    const token = mockAdminUser();
    mockQueryResponse([buildView()]); // selectViewById
    evaluateView.mockResolvedValue([buildEvaluated()]);
    mockQueryResponse([
      { student_id: 's1', name: 'Alice Adams', grade: '5', school: TEST_SCHOOL, mother_email: 'mom@test.com', father_email: 'dad@test.com' },
    ]); // selectStudentEmailsByIds
    mockQueryResponse([buildSchoolRow()]); // selectSchoolByCode
    mockQueryResponse([{ id: 'log-1', sent_at: new Date().toISOString() }]); // createStudentViewCertificateEmail

    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send({ studentIds: ['s1'], customHeader: 'Congratulations!', customMessage: 'Well done.' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.summary).toMatchObject({ total: 1, sent: 1, failed: 0 });
    expect(res.body.results[0]).toMatchObject({ studentId: 's1', status: 'success' });
    expect(res.body.results[0].sentTo).toEqual(['mom@test.com', 'dad@test.com']);
  });

  it('continues the batch and reports students with no parent email as failed', async () => {
    const token = mockAdminUser();
    mockQueryResponse([buildView()]); // selectViewById
    evaluateView.mockResolvedValue([
      buildEvaluated({ studentId: 's1', studentName: 'Alice Adams' }),
      buildEvaluated({ studentId: 's2', studentName: 'Bob Brown' }),
    ]);
    mockQueryResponse([
      { student_id: 's1', name: 'Alice Adams', grade: '5', school: TEST_SCHOOL, mother_email: 'mom@test.com', father_email: null },
      { student_id: 's2', name: 'Bob Brown', grade: '6', school: TEST_SCHOOL, mother_email: null, father_email: null },
    ]); // selectStudentEmailsByIds
    mockQueryResponse([buildSchoolRow()]); // selectSchoolByCode
    mockQueryResponse([{ id: 'log-1', sent_at: new Date().toISOString() }]); // createStudentViewCertificateEmail (s1 only)

    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send({ studentIds: ['s1', 's2'] });

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ total: 2, sent: 1, failed: 1 });
    const bob = res.body.results.find((r) => r.studentId === 's2');
    expect(bob.status).toBe('failed');
    expect(bob.error).toMatch(/parent email/i);
  });
});

describe('POST /api/student-views/:viewId/email/student/:studentId', () => {
  const singleUrl = `/api/student-views/${VIEW_ID}/email/student/s1`;

  it('returns 400 when no recipient email is provided', async () => {
    const token = mockAdminUser();
    const res = await request(app)
      .post(singleUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({ emailAddresses: [] });
    expect(res.status).toBe(400);
  });

  it('returns 401 without an auth token', async () => {
    const res = await request(app).post(singleUrl).send({ emailAddresses: ['mom@test.com'] });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the view does not exist', async () => {
    const token = mockAdminUser();
    mockQueryResponse([]); // selectViewById -> none
    const res = await request(app)
      .post(singleUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({ emailAddresses: ['mom@test.com'] });
    expect(res.status).toBe(404);
  });

  it('returns 400 when the student does not qualify for the view', async () => {
    const token = mockAdminUser();
    mockQueryResponse([buildView()]); // selectViewById
    evaluateView.mockResolvedValue([buildEvaluated({ studentId: 'other' })]); // s1 not present
    const res = await request(app)
      .post(singleUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({ emailAddresses: ['mom@test.com'] });
    expect(res.status).toBe(400);
  });

  it('sends to the explicit recipient and logs the send', async () => {
    const token = mockAdminUser();
    mockQueryResponse([buildView()]); // selectViewById
    evaluateView.mockResolvedValue([buildEvaluated({ studentId: 's1', studentName: 'Alice Adams' })]);
    mockQueryResponse([buildSchoolRow()]); // selectSchoolByCode
    mockQueryResponse([{ id: 'log-1', sent_at: new Date().toISOString() }]); // createStudentViewCertificateEmail

    const res = await request(app)
      .post(singleUrl)
      .set('Authorization', `Bearer ${token}`)
      .send({ emailAddresses: ['mom@test.com'], customMessage: 'So proud!' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.sentTo).toEqual(['mom@test.com']);
    expect(res.body.data.id).toBe('log-1');
  });
});
