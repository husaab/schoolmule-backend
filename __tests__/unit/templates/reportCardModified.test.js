// The legacy report cards print if the engine fails, so a fallback mustn't drop the note.

const { getReportCardHTML } = require('../../../templates/reportCardTemplate');
const { getAlHaadiT2ReportCardHTML } = require('../../../templates/alHaadiT2ReportCardTemplate');

const LABEL = 'Earlier grade level skills';
const NOTE = `* Includes modified assessments: ${LABEL}`;
const student = (grade = '5') => ({ name: 'Adam Test', grade, oen: '', homeroomTeacher: 'Ms. Rivera', daysOfAbsence: 0, school: 'PLAYGROUND' });
const base = { schoolInfo: { name: 'Test School' }, schoolAssets: {}, student: student(), term: 'Term 1', generatedDate: 'Nov 6, 2026' };

describe('the legacy standard card', () => {
  const html = (sub, extra = {}) => getReportCardHTML({ ...base, ...extra, feedbacks: [], subjects: [{ subject: 'Mathematics', grade: 86.75, ...sub }] });

  it('stars the mark and prints the note', () => {
    const out = html({ modified: true, modifiedLabels: [LABEL] });
    expect(out).toContain('86.8%*');
    expect(out).toContain(NOTE);
  });

  it('stars a letter grade', () => {
    expect(html({ modified: true, modifiedLabels: [] }, { student: student('2') })).toContain('>A*<');
  });

  it('never stars a mark with no evidence', () => {
    expect(html({ grade: null, modified: true, modifiedLabels: [] })).not.toContain('I*');
  });

  it('prints nothing without the flag', () => {
    const out = html({});
    expect(out).toContain('86.8%');
    expect(out).not.toContain('86.8%*');
    expect(out).not.toContain('Includes modified');
  });

  it('prints a hostile label as text', () => {
    const out = html({ modified: true, modifiedLabels: ['<b>Grade 3</b>'] });
    expect(out).not.toContain('<b>Grade 3');
    expect(out).toContain('&lt;b&gt;Grade 3&lt;/b&gt;');
  });
});

describe('the legacy First / Second / Final card', () => {
  const html = (sub) => getAlHaadiT2ReportCardHTML({
    ...base, feedbacksT1: [], feedbacksT2: [], subjects: [{ subject: 'Mathematics', t1: 73.9, t2: 86.75, final: 80.3, ...sub }],
  });

  it('stars the affected term and the final', () => {
    const out = html({ t1Modified: true, finalModified: true, modifiedLabels: [LABEL] });
    expect(out).toContain('73.9%*');
    expect(out).toContain('80.3%*');
    expect(out).not.toContain('86.8%*');
    expect(out).toContain(NOTE);
  });

  it('prints nothing without the flag', () => {
    const out = html({});
    expect(out).not.toContain('%*');
    expect(out).not.toContain('Includes modified');
  });
});
