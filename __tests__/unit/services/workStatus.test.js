// The single work-status rule (spec 0.8): what a student, their parent and the
// teacher's counts call one item for one student. The SQL twin
// (WORK_STATE_SQL) is checked against this in studentWork.routes.test.js.

const { workStatus, isGradeVisible, isTurnInItem } = require('../../../services/classroom/workStatus');

const NOW = new Date('2026-10-16T14:00:00Z');
const PAST = '2026-10-15T19:30:00.000Z';
const FUTURE = '2026-10-20T19:30:00.000Z';

const assignment = (extra = {}) => ({ kind: 'assignment', submissionMode: 'file', assessmentId: 'a1', dueAt: FUTURE, ...extra });
const published = (row) => ({ isPublished: true, row });
const unpublished = (row) => ({ isPublished: false, row });
const NO_GRADE = { isPublished: false, row: null };

describe('workStatus', () => {
  it('1. a published excused cell is excused, even when turned in late', () => {
    expect(workStatus(assignment(), { turnedInAt: PAST, isLate: true }, published({ score: null, status: 'excused' }), NOW))
      .toEqual({ status: 'excused', isLate: false, missingDerived: false });
  });

  it('2. a published missing cell is a confirmed missing', () => {
    expect(workStatus(assignment(), null, published({ score: null, status: 'missing' }), NOW))
      .toEqual({ status: 'missing', isLate: false, missingDerived: false });
  });

  it('published missing beats turned in', () => {
    expect(workStatus(assignment(), { turnedInAt: PAST, isLate: false }, published({ score: null, status: 'missing' }), NOW))
      .toEqual({ status: 'missing', isLate: false, missingDerived: false });
  });

  it('3. a published score is graded and keeps the late flag', () => {
    expect(workStatus(assignment(), { turnedInAt: PAST, isLate: true }, published({ score: 8, status: 'graded' }), NOW))
      .toEqual({ status: 'graded', isLate: true, missingDerived: false });
    expect(workStatus(assignment(), null, published({ score: 0, status: 'graded' }), NOW))
      .toEqual({ status: 'graded', isLate: false, missingDerived: false });
  });

  it('a score on an unpublished assessment is never visible (drafts do not leak)', () => {
    expect(workStatus(assignment(), null, unpublished({ score: 9, status: 'graded' }), NOW).status).toBe('assigned');
    expect(workStatus(assignment(), null, unpublished({ score: null, status: 'excused' }), NOW).status).toBe('assigned');
  });

  it('a blank published cell (no score, status graded) is not a grade', () => {
    expect(workStatus(assignment(), null, published({ score: null, status: 'graded' }), NOW).status).toBe('assigned');
  });

  it('4. a material is material', () => {
    expect(workStatus({ kind: 'material', assessmentId: null, dueAt: null }, null, NO_GRADE, NOW).status).toBe('material');
  });

  it('5. a plain assessment, or an assignment with nothing to turn in, has no turn-in', () => {
    expect(workStatus({ kind: 'assessment', assessmentId: 'a1', dueAt: null }, null, NO_GRADE, NOW))
      .toEqual({ status: 'no_turn_in', isLate: false, missingDerived: false });
    expect(workStatus(assignment({ submissionMode: 'none', dueAt: PAST }), null, NO_GRADE, NOW).status).toBe('no_turn_in');
    // ...but a published grade on it still shows.
    expect(workStatus({ kind: 'assessment', assessmentId: 'a1', dueAt: null }, null, published({ score: 7, status: 'graded' }), NOW).status)
      .toBe('graded');
  });

  it('6. turned in, with the late flag from the submission', () => {
    expect(workStatus(assignment({ dueAt: PAST }), { turnedInAt: PAST, isLate: false }, NO_GRADE, NOW))
      .toEqual({ status: 'turned_in', isLate: false, missingDerived: false });
    expect(workStatus(assignment({ dueAt: PAST }), { turnedInAt: NOW.toISOString(), isLate: true }, NO_GRADE, NOW))
      .toEqual({ status: 'turned_in', isLate: true, missingDerived: false });
  });

  it('7. past due with nothing turned in is a derived missing (nothing written)', () => {
    expect(workStatus(assignment({ dueAt: PAST }), null, NO_GRADE, NOW))
      .toEqual({ status: 'missing', isLate: false, missingDerived: true });
    expect(workStatus(assignment({ dueAt: PAST }), { turnedInAt: null, isLate: true }, NO_GRADE, NOW).missingDerived).toBe(true);
    expect(workStatus({ kind: 'quiz', submissionMode: 'none', assessmentId: null, dueAt: PAST }, null, NO_GRADE, NOW).status).toBe('missing');
  });

  it('8. otherwise assigned (future due date, or none)', () => {
    expect(workStatus(assignment(), null, NO_GRADE, NOW)).toEqual({ status: 'assigned', isLate: false, missingDerived: false });
    expect(workStatus(assignment({ dueAt: null }), null, NO_GRADE, NOW).status).toBe('assigned');
    expect(workStatus(assignment({ dueAt: NOW.toISOString() }), null, NO_GRADE, NOW).status).toBe('assigned'); // due exactly now: not yet past
  });

  it('defaults now to the current time', () => {
    expect(workStatus(assignment({ dueAt: '2000-01-01T00:00:00Z' }), null, NO_GRADE).status).toBe('missing');
  });
});

describe('helpers', () => {
  it('isGradeVisible follows spec 0.8', () => {
    expect(isGradeVisible(published({ score: 0, status: 'graded' }))).toBe(true);
    expect(isGradeVisible(published({ score: null, status: 'missing' }))).toBe(true);
    expect(isGradeVisible(published(null))).toBe(false);
    expect(isGradeVisible(unpublished({ score: 5, status: 'graded' }))).toBe(false);
    expect(isGradeVisible(null)).toBe(false);
  });

  it('isTurnInItem: assignments that take work, and quizzes', () => {
    expect(isTurnInItem({ kind: 'assignment', submissionMode: 'file' })).toBe(true);
    expect(isTurnInItem({ kind: 'assignment', submissionMode: 'done' })).toBe(true);
    expect(isTurnInItem({ kind: 'assignment' })).toBe(true);
    expect(isTurnInItem({ kind: 'assignment', submissionMode: 'none' })).toBe(false);
    expect(isTurnInItem({ kind: 'quiz', submissionMode: 'none' })).toBe(true);
    expect(isTurnInItem({ kind: 'assessment' })).toBe(false);
    expect(isTurnInItem({ kind: 'material' })).toBe(false);
  });
});
