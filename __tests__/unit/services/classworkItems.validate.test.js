// validateItemInput: every rule of the classwork item form, one assertion each.
const { validateItemInput, D2_MESSAGE } = require('../../../services/classroom/classworkItems');

const HOMEWORK = 'aaaaaaaa-0000-4000-8000-000000000001';
const TESTS = 'aaaaaaaa-0000-4000-8000-000000000002';
const COLUMN = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER_COLUMN = 'bbbbbbbb-0000-4000-8000-000000000009';
const TOPIC = 'cccccccc-0000-4000-8000-000000000001';
const S1 = 'dddddddd-0000-4000-8000-000000000001';
const S2 = 'dddddddd-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-16T12:00:00Z');

const ctx = (extra = {}) => ({
  categories: [{ assessmentId: HOMEWORK, name: 'Homework' }, { assessmentId: TESTS, name: 'Tests' }],
  linkableColumns: [{ assessmentId: COLUMN }],
  roster: [S1, S2],
  topics: [TOPIC],
  now: NOW,
  ...extra,
});
const assignment = (extra = {}) => ({ kind: 'assignment', title: 'Plant cell diagram', ...extra });
const assessment = (extra = {}) => ({
  kind: 'assessment', title: 'Unit 2 test', gradebook: { mode: 'category', categoryId: TESTS, maxScore: 30 }, ...extra,
});
const errorOf = (input, c = ctx()) => validateItemInput(input, c).error;
const valueOf = (input, c = ctx()) => {
  const r = validateItemInput(input, c);
  if (r.error) throw new Error(`unexpected error: ${r.error}`);
  return r.value;
};

describe('validateItemInput: title and instructions', () => {
  it('needs a title', () => expect(errorOf(assignment({ title: '   ' }))).toMatch(/title/i));
  it('a missing title is refused too', () => expect(errorOf({ kind: 'material' })).toMatch(/title/i));
  it('keeps the title to 200 characters', () => expect(errorOf(assignment({ title: 'x'.repeat(201) }))).toMatch(/200/));
  it('trims the title', () => expect(valueOf(assignment({ title: '  Diagram  ' })).title).toBe('Diagram'));
  it('keeps instructions to 20,000 characters', () => expect(errorOf(assignment({ instructions: 'x'.repeat(20001) }))).toMatch(/20,000/));
  it('empty instructions become null', () => expect(valueOf(assignment({ instructions: '  ' })).instructions).toBeNull());
});

describe('validateItemInput: kind and gradebook', () => {
  it('refuses an unknown kind', () => expect(errorOf({ kind: 'essay', title: 'x' })).toMatch(/Assessment, Assignment, Quiz or Material/));
  it('an assessment in a class with no categories gets the D2 message', () => {
    expect(errorOf(assessment({ gradebook: { mode: 'none' } }), ctx({ categories: [] }))).toBe(D2_MESSAGE);
  });
  it('the D2 message is the brief\'s copy', () => {
    expect(D2_MESSAGE).toBe('Add a category in Grades → Assessments & categories first, or fill an existing column.');
  });
  it('an assessment must count toward a category', () => {
    expect(errorOf(assessment({ gradebook: { mode: 'none' } }))).toMatch(/category/i);
  });
  it('an assessment cannot just fill an existing column', () => {
    expect(errorOf(assessment({ gradebook: { mode: 'existing', assessmentId: COLUMN } }))).toMatch(/category/i);
  });
  it('the category must be one of this class\'s', () => {
    expect(errorOf(assessment({ gradebook: { mode: 'category', categoryId: OTHER_COLUMN, maxScore: 10 } }))).toMatch(/categories/i);
  });
  it('out of must be more than 0', () => {
    expect(errorOf(assessment({ gradebook: { mode: 'category', categoryId: TESTS, maxScore: 0 } }))).toMatch(/more than 0/);
  });
  it('out of must be a number', () => {
    expect(errorOf(assessment({ gradebook: { mode: 'category', categoryId: TESTS, maxScore: 'ten' } }))).toMatch(/more than 0/);
  });
  it('an assessment has no due time and nothing to turn in', () => {
    const v = valueOf(assessment({ dueAt: '2026-10-20T12:00:00Z', submissionMode: 'file' }));
    expect([v.dueAt, v.submissionMode]).toEqual([null, 'none']);
  });
  it('an assessment keeps its date', () => expect(valueOf(assessment({ date: '2026-10-23' })).date).toBe('2026-10-23'));
  it('an assignment may count toward a category', () => {
    expect(valueOf(assignment({ gradebook: { mode: 'category', categoryId: HOMEWORK, maxScore: 10 } })).gradebook)
      .toEqual({ mode: 'category', categoryId: HOMEWORK, maxScore: 10 });
  });
  it('a quiz may fill an existing column', () => {
    expect(valueOf({ kind: 'quiz', title: 'Cells quiz', gradebook: { mode: 'existing', assessmentId: COLUMN } }).gradebook)
      .toEqual({ mode: 'existing', assessmentId: COLUMN });
  });
  it('an assignment may be not graded', () => expect(valueOf(assignment({ gradebook: { mode: 'none' } })).gradebook).toEqual({ mode: 'none' }));
  it('an assignment with no gradebook choice is not graded', () => expect(valueOf(assignment()).gradebook).toEqual({ mode: 'none' }));
  it('an existing column must be a linkable column of this class', () => {
    expect(errorOf(assignment({ gradebook: { mode: 'existing', assessmentId: OTHER_COLUMN } }))).toMatch(/column/i);
  });
  it('refuses an unknown gradebook mode', () => expect(errorOf(assignment({ gradebook: { mode: 'weird' } }))).toMatch(/gradebook/i));
  it('a material is never graded, has nothing to turn in and no due date', () => {
    const v = valueOf({
      kind: 'material', title: 'Reading', dueAt: '2026-10-20T12:00:00Z', submissionMode: 'file',
      gradebook: { mode: 'category', categoryId: HOMEWORK, maxScore: 10 },
    });
    expect([v.gradebook, v.submissionMode, v.dueAt]).toEqual([{ mode: 'none' }, 'none', null]);
  });
});

describe('validateItemInput: turn-in and dates', () => {
  it('an assignment takes file, text, done or none', () => expect(valueOf(assignment({ submissionMode: 'text' })).submissionMode).toBe('text'));
  it('an assignment defaults to a file turn-in', () => expect(valueOf(assignment()).submissionMode).toBe('file'));
  it('refuses an unknown turn-in mode', () => expect(errorOf(assignment({ submissionMode: 'fax' }))).toMatch(/turn it in/));
  it('a quiz turns in through the quiz, not a mode', () => expect(valueOf({ kind: 'quiz', title: 'Q', submissionMode: 'file' }).submissionMode).toBe('none'));
  it('a due time must be a real date', () => expect(errorOf(assignment({ dueAt: 'next friday' }))).toMatch(/due/i));
  it('a due time is kept as ISO', () => expect(valueOf(assignment({ dueAt: '2026-10-20T23:59:00-04:00' })).dueAt).toBe('2026-10-21T03:59:00.000Z'));
  it('a date must be YYYY-MM-DD', () => expect(errorOf(assessment({ date: '23/10/2026' }))).toMatch(/YYYY-MM-DD/));
  it('a date must exist on the calendar', () => expect(errorOf(assessment({ date: '2026-02-30' }))).toMatch(/YYYY-MM-DD/));
});

describe('validateItemInput: status and schedule', () => {
  it('refuses an unknown status', () => expect(errorOf(assignment({ status: 'live' }))).toMatch(/draft, scheduled or posted/));
  it('defaults to posted', () => expect(valueOf(assignment()).status).toBe('posted'));
  it('scheduled needs a publish time', () => expect(errorOf(assignment({ status: 'scheduled' }))).toMatch(/future/));
  it('scheduled needs a publish time in the future', () => {
    expect(errorOf(assignment({ status: 'scheduled', publishAt: '2026-10-16T11:00:00Z' }))).toMatch(/future/);
  });
  it('scheduled in the future is accepted', () => {
    expect(valueOf(assignment({ status: 'scheduled', publishAt: '2026-10-19T11:30:00Z' })).publishAt).toBe('2026-10-19T11:30:00.000Z');
  });
  it('a publish time is dropped unless the item is scheduled', () => {
    expect(valueOf(assignment({ status: 'draft', publishAt: '2026-10-19T11:30:00Z' })).publishAt).toBeNull();
  });
});

describe('validateItemInput: audience and topic', () => {
  it('refuses an unknown audience', () => expect(errorOf(assignment({ audience: 'class' }))).toMatch(/all or some/));
  it('some needs at least one student', () => expect(errorOf(assignment({ audience: 'some', studentIds: [] }))).toMatch(/at least one/));
  it('some takes at most 500 students', () => {
    const many = Array.from({ length: 501 }, (_, i) => `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(errorOf(assignment({ audience: 'some', studentIds: many }), ctx({ roster: many }))).toMatch(/500/);
  });
  it('some takes only students on the roster', () => {
    expect(errorOf(assignment({ audience: 'some', studentIds: [S1, OTHER_COLUMN] }))).toMatch(/aren't in this class/);
  });
  it('some dedupes and lower-cases student ids', () => {
    expect(valueOf(assignment({ audience: 'some', studentIds: [S1.toUpperCase(), S1, S2] })).studentIds).toEqual([S1, S2]);
  });
  it('all clears any student list', () => expect(valueOf(assignment({ audience: 'all', studentIds: [S1] })).studentIds).toEqual([]));
  it('the topic must belong to the class', () => expect(errorOf(assignment({ topicId: OTHER_COLUMN }))).toMatch(/topics/));
  it('a topic of the class is kept', () => expect(valueOf(assignment({ topicId: TOPIC })).topicId).toBe(TOPIC));
});

describe('validateItemInput: edits (current item + a partial change)', () => {
  const legacy = {
    kind: 'assessment', title: 'Old quiz', instructions: null, topicId: null, dueAt: null, date: '2026-10-01',
    submissionMode: 'none', status: 'posted', publishAt: null, audience: 'all', studentIds: [],
    emailStudents: true, remindStudents: true, showEarly: false, assessmentId: COLUMN, categoryId: null, maxScore: 10,
  };
  it('a legacy assessment outside any category can still be renamed (its column is kept)', () => {
    const v = valueOf({ title: 'Renamed quiz' }, ctx({ current: legacy }));
    expect([v.title, v.gradebook]).toEqual(['Renamed quiz', { mode: 'keep' }]);
  });
  it('an unchanged past publish time on a scheduled item is not re-checked', () => {
    const current = { ...legacy, kind: 'assignment', status: 'scheduled', publishAt: '2026-10-16T11:00:00.000Z', assessmentId: null };
    expect(validateItemInput({ title: 'Renamed' }, ctx({ current })).error).toBeUndefined();
  });
  it('an edit that makes a linked item a material drops its column', () => {
    const current = { ...legacy, kind: 'assignment' };
    expect(valueOf({ kind: 'material' }, ctx({ current })).gradebook).toEqual({ mode: 'none' });
  });
  it('an unlinked assignment turned into an assessment must choose a category', () => {
    const current = { ...legacy, kind: 'assignment', assessmentId: null };
    expect(validateItemInput({ kind: 'assessment' }, ctx({ current })).error).toMatch(/category/i);
  });
  it('filling the column the item already fills is accepted', () => {
    const current = { ...legacy, kind: 'assignment' };
    expect(valueOf({ gradebook: { mode: 'existing', assessmentId: COLUMN } }, ctx({ current, linkableColumns: [] })).gradebook)
      .toEqual({ mode: 'keep' });
  });
});
