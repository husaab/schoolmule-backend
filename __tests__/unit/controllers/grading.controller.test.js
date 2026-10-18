// The grading view's pure shaping: labels, needsPublish, counts and how a
// PATCH merges into the current grade (spec D3, D17).

const { toGradingRow, gradingCounts, gradingLabel, nextGrade } = require('../../../controllers/grading.controller');

const raw = (overrides = {}) => ({
  student_id: 's1',
  name: 'Amal Haddad',
  avatar: null,
  submission_id: 'sub1',
  turned_in_at: null,
  sub_is_late: false,
  text_answer: null,
  draft_score: null,
  draft_status: null,
  feedback: null,
  sub_published_at: null,
  work_status: 'assigned',
  grade_visible: false,
  visible_score: null,
  visible_status: null,
  visible_published_at: null,
  ...overrides,
});
const TURNED_IN = { turned_in_at: '2026-10-15T22:42:00.000Z', work_status: 'turned_in' };
const PUBLISHED = '2026-10-16T14:00:00.000Z';

describe('toGradingRow', () => {
  it('a draft on a gradebook column reads "Graded · draft" and needs a Publish', () => {
    const { row, awaitingGrade } = toGradingRow(raw({ ...TURNED_IN, draft_score: '8.00', draft_status: 'graded' }), { linked: true });
    expect(row).toMatchObject({ draftScore: 8, draftStatus: 'graded', needsPublish: true, label: 'Graded · draft', publishedScore: null });
    expect(awaitingGrade).toBe(false);
  });

  it('turned-in work with nothing graded awaits a grade; late work says so', () => {
    const { row, awaitingGrade } = toGradingRow(raw({ ...TURNED_IN, sub_is_late: true }), { linked: true });
    expect(row).toMatchObject({ label: 'Turned in · late', isLate: true, needsPublish: false });
    expect(awaitingGrade).toBe(true);
  });

  it('a visible grade reads Published, Missing or Excused, with the score only when graded', () => {
    const graded = toGradingRow(raw({
      ...TURNED_IN, work_status: 'graded', draft_score: '8.00', draft_status: 'graded', sub_published_at: PUBLISHED,
      grade_visible: true, visible_score: '8.00', visible_status: 'graded', visible_published_at: PUBLISHED,
    }), { linked: true, assessmentPublished: true }).row;
    expect(graded).toMatchObject({ label: 'Published', publishedScore: 8, publishedStatus: 'graded', publishedAt: PUBLISHED, needsPublish: false });
    const missing = toGradingRow(raw({ work_status: 'missing', grade_visible: true, visible_status: 'missing', sub_published_at: PUBLISHED, draft_status: 'missing' }), { linked: true, assessmentPublished: true }).row;
    expect(missing).toMatchObject({ label: 'Missing', publishedScore: null, publishedStatus: 'missing' });
    const excused = toGradingRow(raw({ work_status: 'excused', grade_visible: true, visible_score: '6.00', visible_status: 'excused', sub_published_at: PUBLISHED, draft_status: 'excused' }), { linked: true, assessmentPublished: true }).row;
    expect(excused).toMatchObject({ label: 'Excused', publishedScore: null });
  });

  it('an item with no gradebook column publishes feedback: pending, then Published', () => {
    const pending = toGradingRow(raw({ ...TURNED_IN, feedback: 'Lovely summary.', draft_score: '3.00' }), { linked: false }).row;
    expect(pending).toMatchObject({ needsPublish: true, label: 'Turned in', draftScore: null, publishedStatus: null });
    const published = toGradingRow(raw({ ...TURNED_IN, feedback: 'Lovely summary.', sub_published_at: PUBLISHED }), { linked: false }).row;
    expect(published).toMatchObject({ needsPublish: false, label: 'Published', publishedAt: PUBLISHED });
  });

  it('a quiz with no gradebook column publishes its results: a turned-in quiz needs a Publish even with no feedback', () => {
    expect(toGradingRow(raw({ ...TURNED_IN }), { linked: false, quiz: true }).row).toMatchObject({ needsPublish: true, label: 'Turned in' });
    expect(toGradingRow(raw({ ...TURNED_IN }), { linked: false }).row.needsPublish).toBe(false); // an assignment needs feedback
    expect(toGradingRow(raw(), { linked: false, quiz: true }).row.needsPublish).toBe(false); // nothing turned in
    const published = toGradingRow(raw({ ...TURNED_IN, sub_published_at: PUBLISHED }), { linked: false, quiz: true }).row;
    expect(published).toMatchObject({ needsPublish: false, label: 'Published' });
  });

  it('a published draft needs a Publish again while its column is unpublished in the gradebook', () => {
    const synced = raw({ ...TURNED_IN, draft_score: '8.00', draft_status: 'graded', sub_published_at: PUBLISHED });
    expect(toGradingRow(synced, { linked: true, assessmentPublished: false }).row).toMatchObject({ needsPublish: true, label: 'Graded · draft' });
    expect(toGradingRow(synced, { linked: true, assessmentPublished: true }).row).toMatchObject({ needsPublish: false });
  });

  it('missing by its due date, and nothing yet', () => {
    expect(toGradingRow(raw({ work_status: 'missing' }), { linked: true }).row.label).toBe('Missing');
    expect(toGradingRow(raw(), { linked: true }).row.label).toBe('Not turned in yet');
  });
});

describe('gradingCounts', () => {
  it('counts the roster, turned in, to grade, missing, drafts to publish and published', () => {
    const shaped = [
      raw({ ...TURNED_IN, draft_score: '8.00', draft_status: 'graded' }),
      raw({ ...TURNED_IN }),
      raw({ work_status: 'missing' }),
      raw({ ...TURNED_IN, work_status: 'graded', sub_published_at: PUBLISHED, draft_score: '7.00', draft_status: 'graded',
        grade_visible: true, visible_score: '7.00', visible_status: 'graded', visible_published_at: PUBLISHED }),
    ].map((r) => toGradingRow(r, { linked: true, assessmentPublished: true }));
    expect(gradingCounts(shaped)).toEqual({ all: 4, turnedIn: 3, toGrade: 1, missing: 1, drafts: 1, published: 1 });
  });
});

describe('gradingLabel', () => {
  it('a pending draft wins over the turn-in state', () => {
    expect(gradingLabel({ isDraft: true, status: 'turned_in', linked: true })).toBe('Graded · draft');
  });
});

describe('nextGrade', () => {
  it('a typed score is evidence: it resets a flag to graded unless one is sent', () => {
    expect(nextGrade({ draft_score: null, draft_status: 'missing' }, { score: 7 })).toEqual({ score: 7, status: 'graded' });
    expect(nextGrade({ draft_score: '7.00', draft_status: 'graded' }, { score: 7, status: 'excused' })).toEqual({ score: 7, status: 'excused' });
  });

  it('a status alone keeps the score, except missing', () => {
    expect(nextGrade({ draft_score: '7.00', draft_status: 'graded' }, { status: 'excused' })).toEqual({ score: 7, status: 'excused' });
    expect(nextGrade({ draft_score: '7.00', draft_status: 'graded' }, { status: 'missing' })).toEqual({ score: null, status: 'missing' });
  });

  it('clearing the score keeps the flag as it was', () => {
    expect(nextGrade({ draft_score: '7.00', draft_status: 'graded' }, { score: null })).toEqual({ score: null, status: 'graded' });
    expect(nextGrade({ draft_score: null, draft_status: null }, { feedback: 'x' })).toEqual({ score: null, status: null });
  });
});
