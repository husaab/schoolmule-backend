const {
  renderAlHaadiProgressReportSK,
  layoutSubjects,
  SK_PROGRESS_COMMENT_ROWS,
} = require('../../../templates/alHaadiProgressReportSKTemplate');
const { renderAlHaadiProgressReportJK, sectionStyle } = require('../../../templates/alHaadiProgressReportJKTemplate');

const SCHOOL = {
  name: 'Test Academy',
  address: '1 Example Rd, Toronto, ON M1M 1M1',
  phone: '(416) 555-0100',
  email: 'office@testacademy.example',
};

const subject = (name, items) => ({
  subjectId: name,
  name,
  standards: items.map((n, i) => ({ standardId: `${name}#${i}`, name: n })),
});

describe('SK progress report', () => {
  const subjects = [
    subject('Mathematics', ['Counts to 100']),
    subject('Literacy - Reading', ['Reads sight words']),
    subject('Literacy - Writing', ['Prints letters']),
    subject('Creativity', ['Draws']),
    subject('Arabic and Quran', ['Arabic letters', 'Participation', 'Surahs']),
    subject('French', ['French letters', 'Participation']),
  ];

  it('groups "Group - Part" subjects under one bar and pairs Arabic and Quran with French', () => {
    const sections = layoutSubjects(subjects);
    expect(sections.map((s) => [s.kind, s.group || null, s.sub || null, s.title || null])).toEqual([
      ['single', null, null, 'Mathematics'],
      ['single', 'Literacy', 'Reading', null],
      ['single', null, 'Writing', null],
      ['single', null, null, 'Creativity'],
      ['pair', null, null, null],
    ]);
    expect(sections[4].left.name).toBe('Arabic and Quran');
    expect(sections[4].right.name).toBe('French');
  });

  it('prints Arabic and Quran on its own when French does not follow it', () => {
    const sections = layoutSubjects([subject('Arabic and Quran', ['x']), subject('Creativity', ['y'])]);
    expect(sections.map((s) => s.kind)).toEqual(['single', 'single']);
  });

  function render(overrides = {}) {
    return renderAlHaadiProgressReportSK({
      schoolInfo: SCHOOL,
      logoDataUri: null,
      student: { name: 'Sample <Student>', oen: '123-456-789', teacherName: 'Sample Teacher', daysAbsent: 4 },
      subjects,
      ratingMap: { 'Mathematics#0': 'G', 'Arabic and Quran#2': 'NI', 'French#1': 'E' },
      comments: { mathematics: 'Counts well.\nNext: <b>teens</b>.', bogus: 'never printed' },
      reportDate: '2026-11-14',
      schoolYearLabel: '2026-2027',
      ...overrides,
    });
  }

  it('prints the masthead, date, student grid and ratings', () => {
    const { html } = render();
    expect(html).toContain('Progress Report:&nbsp;&nbsp;2026 - 2027');
    expect(html).toContain('Date: November 14, 2026');
    expect(html).toContain('Sample &lt;Student&gt;');
    expect(html).toContain('OEN:&nbsp; 123-456-789');
    expect(html).toContain('Days Absent:');
    expect(html).toContain('EVALUATION KEY');
    expect(html).toContain('LEARNING SKILLS');
    expect(html).toMatch(/Counts to 100<\/td>\s*<td class="rating">G<\/td>/);
    // The paired section keeps each subject's ratings in its own column.
    expect(html).toMatch(/Surahs<\/td><td class="rating narrow">NI<\/td>/);
    expect(html).toMatch(/Participation<\/td><td class="rating">E<\/td>/);
  });

  it('prints every Strengths/Next Steps row, escaped, filled or not', () => {
    // The paper template's rows; the web/app copy (src/lib/skProgressComments.ts) pins the same list.
    expect(SK_PROGRESS_COMMENT_ROWS.map((r) => [r.key, r.label])).toEqual([
      ['language_arts', 'Language Arts'],
      ['mathematics', 'Mathematics'],
      ['science', 'Science'],
      ['social_studies', 'Social Studies'],
      ['quran', 'Quran'],
      ['arabic', 'Arabic'],
      ['islamic_studies', 'Islamic Studies'],
      ['creativity', 'Creativity'],
      ['french', 'French'],
    ]);
    const { html } = render();
    for (const row of SK_PROGRESS_COMMENT_ROWS) expect(html).toContain(`>${row.label}`);
    expect(html).toContain('Reading, Writing, Oral communication, Media Literacy');
    expect(html).toContain('Counts well.\nNext: &lt;b&gt;teens&lt;/b&gt;.');
    expect(html).not.toContain('never printed');
    expect(html).toContain("Teacher's Signature:");
    expect(html).toContain("Principal's Signature:");
  });

  it('prints on Letter with a running header from page 2 and a numbered footer', () => {
    const { pdfOptions } = render();
    expect(pdfOptions.format).toBe('Letter');
    expect(pdfOptions.headerTemplate).toContain('Sample &lt;Student&gt;');
    expect(pdfOptions.headerTemplate).toContain('November 14, 2026');
    expect(pdfOptions.firstPage).toEqual({ headerTemplate: '' });
    expect(pdfOptions.footerTemplate).toContain('Page <span class="pageNumber"></span> of <span class="totalPages"></span>');
    expect(pdfOptions.footerTemplate).toContain('1 Example Rd, Toronto, M1M 1M1 | 416-555-0100');
    expect(pdfOptions.footerTemplate).toContain('www.testacademy.example');
    expect(pdfOptions.footerTemplate).toContain('&copy; 2026-27, All Rights Reserved');
  });

  it('prints the principal signature when the school has one', () => {
    expect(render().html).not.toContain('<img');
    const { html } = render({ principalSignatureDataUri: 'data:image/png;base64,SIG' });
    expect(html).toContain('<img src="data:image/png;base64,SIG"');
  });
});

describe('JK progress report', () => {
  const domains = [
    { domainId: 'd1', name: 'Language and Communication Skills', skills: [{ skillId: 's1', name: 'Speaks clearly.' }] },
    { domainId: 'd2', name: 'Social Skills', skills: [{ skillId: 's2', name: 'Shares <toys>.' }] },
    { domainId: 'd3', name: 'Something New', skills: [{ skillId: 's3', name: 'Tries new things.' }] },
  ];

  function render(overrides = {}) {
    return renderAlHaadiProgressReportJK({
      schoolInfo: SCHOOL,
      logoDataUri: 'data:image/png;base64,AAAA',
      student: { name: 'Sample Student', oen: '123-456-789', teacherName: 'Sample Teacher', teacherAssistant: 'Sample Assistant', daysAbsent: 3 },
      domains,
      ratingMap: { s1: 'D', s2: 'B' },
      comments: { academic_achievement: 'Reads well.', socio_emotional: 'Kind & caring.' },
      reportDate: '2026-11-14',
      schoolYearLabel: '2026-2027',
      ...overrides,
    });
  }

  it('styles known sections from the paper template and others neutrally', () => {
    expect(sectionStyle('Language and Communication Skills', 0)).toEqual({ color: '#c9daf8', icon: 'language.png' });
    expect(sectionStyle('Cognitive Development:', 0)).toMatchObject({ color: '#fce5cd', icon: 'cognitive.png' });
    expect(sectionStyle('Social Skills', 0)).toEqual({ color: '#d9ead3' });
    expect(sectionStyle('Something New', 2).icon).toBeUndefined();
  });

  it('prints the student grid, key, sections, comments and sign-off', () => {
    const { html } = render();
    expect(html).toContain('Name of Student:<br />Sample Student');
    expect(html).toContain('Teacher: Sample Teacher<br />Teacher Assistant: Sample Assistant');
    expect(html).toContain('Days of absence<br />3');
    expect(html).toContain('B - Beginning:');
    expect(html).toMatch(/Speaks clearly\.<\/td>\s*<td class="rating">D<\/td>/);
    expect(html).toContain('Shares &lt;toys&gt;.');
    expect(html).toContain('background: #c9daf8;');
    expect(html).toContain('Academic achievement:');
    expect(html).toContain('Kind &amp; caring.');
    expect(html).toContain("Teacher Assistant's Signature:");
    expect(html).toContain('Date: NOVEMBER 14, 2026');
  });

  it('leaves the assistant out when there is none', () => {
    const { html } = render({ student: { name: 'Sample Student', teacherName: 'Sample Teacher', teacherAssistant: '  ', daysAbsent: 0 } });
    expect(html).not.toContain('Teacher Assistant');
  });

  it('prints on A4 with the logo on every page and a numbered footer', () => {
    const { pdfOptions } = render();
    expect(pdfOptions.format).toBe('A4');
    expect(pdfOptions.firstPage).toBeUndefined();
    expect(pdfOptions.headerTemplate).toContain('data:image/png;base64,AAAA');
    expect(pdfOptions.footerTemplate).toContain('<span class="pageNumber"></span>');
    expect(pdfOptions.footerTemplate).toContain('2026-2027 All Rights Reserved');
    expect(render({ logoDataUri: null }).pdfOptions.headerTemplate).toBe('');
  });

  it('prints the principal signature and school stamp when the school has them', () => {
    const { html } = render({ principalSignatureDataUri: 'data:image/png;base64,SIG', schoolStampDataUri: 'data:image/png;base64,STAMP' });
    expect(html).toContain('<img src="data:image/png;base64,SIG"');
    expect(html).toContain('<div class="stamp"><img src="data:image/png;base64,STAMP"');
    expect(render().html).not.toContain('class="stamp"');
  });
});
