// The catch-up for grades published from inside a category with no parent
// email (fixed 8459c5b): one email per student, a section per class.
// Synthetic names only.

const { planCatchUp } = require('../../../services/publishBackfill');

const assessment = (overrides = {}) => ({
  assessment_id: 'a1', class_id: 'c1', name: 'Quiz', is_parent: false, parent_assessment_id: null,
  weight_points: 10, max_score: 10, sort_order: 1, is_published: true, parent_comment: null, ...overrides,
});
const row = (assessmentId, score) => ({ assessment_id: assessmentId, score, is_excluded: false, status: 'graded' });
const student = (studentId, studentName, rows) => [studentId, { studentId, studentName, rows }];

// English: Spelling (category) holds Spelling 1 and 2, both published.
const english = {
  className: 'English',
  allAssessments: [
    assessment({ assessment_id: 'sp', class_id: 'en', name: 'Spelling', is_parent: true, weight_points: 20, max_score: null }),
    assessment({ assessment_id: 'sp1', class_id: 'en', name: 'Spelling 1', parent_assessment_id: 'sp' }),
    assessment({ assessment_id: 'sp2', class_id: 'en', name: 'Spelling 2', parent_assessment_id: 'sp' }),
  ],
  scoreRowsByStudent: new Map([
    student('amal', 'Amal Test', [row('sp1', 9), row('sp2', 8)]),
    student('sami', 'Sami Test', [row('sp1', null), row('sp2', null)]),
  ]),
};
// Math: Workbook Quiz holds Quiz 1 (published) and Quiz 2 (unpublished since).
const math = {
  className: 'Math',
  allAssessments: [
    assessment({ assessment_id: 'wq', class_id: 'ma', name: 'Workbook Quiz', is_parent: true, weight_points: 30, max_score: null }),
    assessment({ assessment_id: 'q1', class_id: 'ma', name: 'Quiz 1', parent_assessment_id: 'wq' }),
    assessment({ assessment_id: 'q2', class_id: 'ma', name: 'Quiz 2', parent_assessment_id: 'wq', is_published: false }),
  ],
  scoreRowsByStudent: new Map([
    student('amal', 'Amal Test', [row('q1', 6), row('q2', 10)]),
    student('lina', 'Lina Test', [row('q2', 7)]),
  ]),
};
const classes = new Map([['en', english], ['ma', math]]);
const pairs = [
  { batchId: 'b1', classId: 'en', studentId: 'amal', assessmentIds: ['sp1'], triggeredBy: 't1' },
  { batchId: 'b2', classId: 'en', studentId: 'amal', assessmentIds: ['sp2'], triggeredBy: 't1' },
  { batchId: 'b3', classId: 'ma', studentId: 'amal', assessmentIds: ['q1', 'q2'], triggeredBy: 't2' },
  { batchId: 'b3', classId: 'ma', studentId: 'lina', assessmentIds: ['q1', 'q2'], triggeredBy: 't2' },
  { batchId: 'b1', classId: 'en', studentId: 'sami', assessmentIds: ['sp1'], triggeredBy: 't1' },
];

describe('planCatchUp', () => {
  const plan = planCatchUp({ pairs, classes });

  it('gives a student one email with a section per class, each listed through its category line', () => {
    const amal = plan.find((p) => p.studentId === 'amal');
    expect(amal.studentName).toBe('Amal Test');
    expect(amal.classes.map((c) => c.className)).toEqual(['English', 'Math']);
    // Two separate publishes in English become one Spelling line (both items count).
    expect(amal.classes[0].lines).toEqual([{ name: 'Spelling', scoreLabel: '', pctLabel: '(85%)', comment: null }]);
    // Quiz 2 was unpublished since: only Quiz 1 counts, and only it is recorded as emailed.
    expect(amal.classes[1].lines).toEqual([{ name: 'Workbook Quiz', scoreLabel: '', pctLabel: '(60%)', comment: null }]);
    expect(amal.classes[1].audit).toEqual([{ batchId: 'b3', triggeredBy: 't2', assessmentIds: ['q1'] }]);
    expect(amal.classes[0].audit.map((a) => a.batchId)).toEqual(['b1', 'b2']);
  });

  it('leaves out a student with nothing graded that is still published', () => {
    expect(plan.map((p) => p.studentId).sort()).toEqual(['amal']);
  });

  it('is empty when nothing was missed', () => {
    expect(planCatchUp({ pairs: [], classes })).toEqual([]);
  });
});
