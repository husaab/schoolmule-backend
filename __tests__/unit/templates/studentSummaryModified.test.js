// The Student Summary PDFs list each assessment and can be handed to parents.

const { getStudentSummaryHTML } = require('../../../templates/studentSummaryTemplate');
const { getStudentSummaryHTMLHorizontal } = require('../../../templates/studentSummaryTemplateHorizontal');

const LABEL = 'Earlier grade level skills';
const assessment = (extra = {}) => ({
  assessment_id: 'a1', name: 'Fractions Test', is_parent: false, parent_assessment_id: null, weight_points: 20, max_score: 50, date: '2026-11-04', ...extra,
});
const score = (extra = {}) => ({ assessment_id: 'a1', score: 36, max_score: 50, status: 'graded', is_excluded: false, is_modified: false, modified_label: null, ...extra });
const args = (assessments, studentAssessments) => ({
  schoolInfo: { name: 'Test School', address: '', phone: '', email: '' },
  student: { name: 'Adam Test', grade: '5' },
  classInfo: { subject: 'Math', teacher_name: 'Ms. Rivera' },
  term: { name: 'Term 1' },
  assessments,
  studentAssessments,
  calculatedGrade: 72,
});

describe.each([
  ['portrait', getStudentSummaryHTML],
  ['landscape', getStudentSummaryHTMLHorizontal],
])('the %s summary', (_name, render) => {
  it('names the label on a modified mark', () => {
    const html = render(args([assessment()], [score({ is_modified: true, modified_label: LABEL })]));
    expect(html).toContain(`Modified assessment · ${LABEL}`);
  });

  it('stands alone with no label', () => {
    const html = render(args([assessment()], [score({ is_modified: true })]));
    expect(html).toContain('>Modified assessment<');
  });

  it('names it on an assessment inside a category', () => {
    const parent = assessment({ assessment_id: 'cat', name: 'Tests', is_parent: true });
    const child = assessment({ parent_assessment_id: 'cat' });
    const html = render(args([parent, child], [score({ is_modified: true, modified_label: LABEL })]));
    expect(html).toContain(`Modified assessment · ${LABEL}`);
  });

  it('shows nothing on a missing mark with the flag', () => {
    const html = render(args([assessment()], [score({ is_modified: true, modified_label: LABEL, status: 'missing', score: null })]));
    expect(html).not.toContain('Modified assessment');
  });

  it('shows nothing on an ordinary mark', () => {
    expect(render(args([assessment()], [score()]))).not.toContain('Modified assessment');
  });

  it('prints a hostile label as text', () => {
    const html = render(args([assessment()], [score({ is_modified: true, modified_label: '<b>Grade 3</b>' })]));
    expect(html).not.toContain('<b>Grade 3');
    expect(html).toContain('&lt;b&gt;Grade 3&lt;/b&gt;');
  });
});
