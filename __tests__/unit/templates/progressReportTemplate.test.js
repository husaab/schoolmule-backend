// The progress report PDF's HTML: what a teacher typed is escaped, so a stray
// "<" or "&" prints as written and can't inject markup into the report.

const { getProgressReportHTML } = require('../../../templates/progressReportTemplate');

const render = (subject) =>
  getProgressReportHTML({
    schoolInfo: { name: 'Al Haadi Academy' },
    student: { name: 'Adam Rahman', grade: '5' },
    term: 'Term 1',
    progressData: [{ subject: 'Math', teacherName: 'Ms T', workHabit: 'G', behavior: 'E', ...subject }],
    generatedDate: 'Oct 31, 2026',
    schoolAssets: null,
  });

describe('progressReportTemplate', () => {
  it('escapes the comment and keeps **bold**', () => {
    const html = render({ comment: '<b>x</b> & **Bold**' });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; &amp; <strong>Bold</strong>');
    expect(html).not.toContain('<b>x</b>');
  });

  it('escapes the Core Standards value', () => {
    const html = render({ coreStandards: '<i>y</i>' });
    expect(html).toContain('&lt;i&gt;y&lt;/i&gt;');
    expect(html).not.toContain('<i>y</i>');
  });

  it('prints a plain comment as written', () => {
    expect(render({ comment: 'Adam is meeting expectations.' })).toContain('Adam is meeting expectations.');
  });
});
