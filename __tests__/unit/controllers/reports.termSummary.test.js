// POST /api/reports/student-summary/:studentId?termId= — every class a
// student is in that term, in one PDF (a term-grades page, then each class).
jest.mock('puppeteer', () => {
  const page = {
    setContent: jest.fn(),
    evaluate: jest.fn(),
    // A real one-page PDF, so the controller's pdf-lib merge has something to load.
    pdf: jest.fn(async () => {
      const { PDFDocument } = require('pdf-lib');
      const doc = await PDFDocument.create();
      doc.addPage();
      return Buffer.from(await doc.save());
    }),
    close: jest.fn(),
  };
  return {
    __page: page,
    launch: jest.fn().mockResolvedValue({ newPage: jest.fn().mockResolvedValue(page), close: jest.fn().mockResolvedValue() }),
  };
});

const request = require('supertest');
const puppeteer = require('puppeteer');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, TEST_SCHOOL, TEST_TEACHER_USER_ID } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const { giveRole } = require('../../helpers/mockAccess');
const db = require('../../__mocks__/config/database');
const { buildStudentRow, buildSchoolRow, buildTermRow, buildAssessmentRow } = require('../../helpers/factories');

const app = getApp();

const CLASS_A = '11111111-1111-4111-8111-111111111111';
const CLASS_B = '22222222-2222-4222-8222-222222222222';
const OTHER_TEACHER = '99999999-9999-4999-8999-999999999999';
const STUDENT = '44444444-4444-4444-8444-444444444444';

const classRow = (class_id, subject, teacher_id = OTHER_TEACHER) => ({
  class_id, subject, teacher_name: 'Ms. Example', teacher_id, school: TEST_SCHOOL,
  term_id: TERM, term_name: 'Term 1', class_grade: '3', is_co_teacher: false,
});

const TERM = '33333333-3333-4333-8333-333333333333';
const url = (studentId, query = `?termId=${TERM}`) => `/api/reports/student-summary/${studentId}${query}`;

/** Queues the reads up to the class list; returns the student. */
const queueLookups = (classes) => {
  const student = buildStudentRow({ student_id: STUDENT, school: TEST_SCHOOL, name: 'Sample Student' });
  mockQueryResponse([student]);
  mockQueryResponse([buildTermRow({ term_id: TERM, name: 'Term 1' })]);
  mockQueryResponse(classes);
  return student;
};

/** Queues the school, assessments, scores and attendance reads. */
const queueContent = (classIds) => {
  mockQueryResponse([buildSchoolRow({ school_code: TEST_SCHOOL })]);
  mockQueryResponse(classIds.map((id) => ({ ...buildAssessmentRow({ class_id: id }), class_id: id, is_parent: false, parent_assessment_id: null })));
  mockQueryResponse([]);
  mockQueryResponse([{ days_absent: '1' }]);
};

describe('POST /api/reports/student-summary/:studentId (all classes)', () => {
  beforeEach(() => puppeteer.__page.pdf.mockClear());

  it('builds one PDF: a term-grades page, then a page per class', async () => {
    const token = mockAdminUser();
    const student = queueLookups([classRow(CLASS_A, 'Math'), classRow(CLASS_B, 'Science')]);
    queueContent([CLASS_A, CLASS_B]);

    const res = await request(app).post(url(student.student_id)).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('Sample_Student_Term_1_All_classes_Summary.pdf');
    expect(puppeteer.__page.pdf).toHaveBeenCalledTimes(3);
    // The term is looked up inside the caller's school.
    expect(db.query.mock.calls.find(([sql]) => sql.includes('FROM terms'))[1]).toEqual([TERM, TEST_SCHOOL]);
  });

  it('asks for a term', async () => {
    const token = mockAdminUser();
    const res = await request(app).post(url(STUDENT, '')).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('treats a malformed id as not found, without reading', async () => {
    const token = mockAdminUser();
    const badTerm = await request(app).post(url(STUDENT, '?termId=nope')).set('Authorization', `Bearer ${token}`);
    expect(badTerm.status).toBe(404);
    const badStudent = await request(app).post(url('nope')).set('Authorization', `Bearer ${token}`);
    expect(badStudent.status).toBe(404);
    expect(db.query.mock.calls.some(([sql]) => sql.includes('FROM students'))).toBe(false);
  });

  it("is a 404 for another school's student", async () => {
    const token = mockAdminUser();
    mockQueryResponse([buildStudentRow({ school: 'SOMEWHERE_ELSE' })]);
    const res = await request(app).post(url(STUDENT)).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('is a 404 for a term that is not in the school', async () => {
    const token = mockAdminUser();
    mockQueryResponse([buildStudentRow({ school: TEST_SCHOOL })]);
    mockQueryResponse([]);
    const res = await request(app).post(url(STUDENT)).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Term not found');
  });

  it('says so when the student has no classes that term', async () => {
    const token = mockAdminUser();
    queueLookups([]);
    const res = await request(app).post(url(STUDENT)).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Sample Student isn't in any Term 1 classes");
  });

  it('gives a teacher without report_cards only the classes they teach', async () => {
    const token = mockTeacherUser();
    giveRole(TEST_TEACHER_USER_ID, ['students']);
    const student = queueLookups([classRow(CLASS_A, 'Math', TEST_TEACHER_USER_ID), classRow(CLASS_B, 'Science')]);
    queueContent([CLASS_A]);

    const res = await request(app).post(url(student.student_id)).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(puppeteer.__page.pdf).toHaveBeenCalledTimes(2);
    // Only the taught class is read.
    expect(db.query.mock.calls.find(([sql]) => sql.includes('FROM assessments\n  WHERE class_id = ANY'))[1]).toEqual([[CLASS_A]]);
  });

  it('refuses a teacher without report_cards who teaches none of them', async () => {
    const token = mockTeacherUser();
    giveRole(TEST_TEACHER_USER_ID, ['students']);
    queueLookups([classRow(CLASS_A, 'Math'), classRow(CLASS_B, 'Science')]);

    const res = await request(app).post(url(STUDENT)).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(puppeteer.__page.pdf).not.toHaveBeenCalled();
  });

  it('lets a teacher with report_cards (the default) have every class', async () => {
    const token = mockTeacherUser();
    const student = queueLookups([classRow(CLASS_A, 'Math'), classRow(CLASS_B, 'Science')]);
    queueContent([CLASS_A, CLASS_B]);

    const res = await request(app).post(url(student.student_id)).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(puppeteer.__page.pdf).toHaveBeenCalledTimes(3);
  });
});
