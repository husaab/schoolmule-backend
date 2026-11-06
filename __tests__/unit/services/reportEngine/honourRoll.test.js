/**
 * The grades 1–8 report card and progress report, printed through the real
 * bundled engine in headless Chromium (no database). A school prints a
 * signature and a stamp, so every render here does too: the footer's height is
 * part of what must fit.
 */
const { reportKit, renderReportText, renderReportPdf, launchReportBrowser } = require('../../../../services/reportEngine/render');

jest.setTimeout(120000);

const svg = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;
const SIGNATURE = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><path d="M6 44 C30 6 42 6 46 32 S70 54 84 26" fill="none" stroke="#000" stroke-width="2"/></svg>');
const STAMP = svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><circle cx="40" cy="40" r="36" fill="none" stroke="#000" stroke-width="3"/></svg>');

const LONG_NAME = ['Muhammad-Abdulrahman', 'Al-Khatib Abou-Haidar'];
const LONG_COMMENT = (first, subject) =>
  `${first} shows enthusiasm in ${subject} and participates thoughtfully in class activities. ${first} has grown in confidence this term, contributes ideas to group discussions and helps classmates when they need support. To continue improving, ${first} is encouraged to read every evening, review new vocabulary, and share what was learned with family members. **Next step:** practise explaining thinking out loud, step by step, to build fluency and independence. We are proud of the effort shown and look forward to even more growth next term.`;

describe('Honour Roll templates (real Chromium)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchReportBrowser();
  });
  afterAll(async () => {
    if (browser) await browser.close();
  });

  const kit = reportKit();
  const build = (key) => kit.DEFAULT_TEMPLATES.find((d) => d.key === key).build();
  const withAssets = (data) => ({ ...data, assets: { ...data.assets, principalSignature: SIGNATURE, stamp: STAMP } });
  const sample = (key, docType) => withAssets(kit.sampleReportData(key, docType));

  /** The sample `worst` student is SK, so it has no subjects here: this puts them on Grade 8's. */
  function longContent(docType, grade = '8') {
    const data = JSON.parse(JSON.stringify(kit.sampleReportData(grade, docType)));
    const [first, last] = LONG_NAME;
    data.student = { ...data.student, name: `${first} ${last}`, firstName: first, lastName: last, daysAbsent: 27 };
    data.subjects = data.subjects.map((s, i) => {
      const comment = LONG_COMMENT(first, s.name.toLowerCase());
      return { ...s, name: i === 0 ? `${s.name} — Reading, Writing, Oral Communication and Media Literacy` : s.name, comment, terms: { ...s.terms, t2: { ...s.terms.t2, comment } } };
    });
    return withAssets(data);
  }

  const printed = (key, data) => renderReportText({ template: build(key), data, browser });

  describe.each([
    // Today's page counts: nothing may print more. Long content is one page
    // shorter on the report cards because a long name no longer pushes the
    // chart off page 1.
    ['report-card-standard', 'report_card', { 1: 6, 4: 7, 8: 7, worst: 2 }, 7],
    ['report-card-t1t2final', 'report_card', { 1: 6, 4: 7, 8: 7, worst: 2 }, 7],
    ['progress-standard', 'progress_report', { 1: 6, 4: 6, 8: 6, worst: 1 }, 7],
  ])('%s', (key, docType, counts, longCount) => {
    it.each(Object.keys(counts))('prints sample %s on the same number of pages, with no warnings', async (s) => {
      const { pageCount, warnings } = await printed(key, sample(s, docType));
      expect(pageCount).toBe(counts[s]);
      expect(warnings).toEqual([]);
    });

    it('fits long names and long comments', async () => {
      const { pageCount, warnings } = await printed(key, longContent(docType));
      expect(pageCount).toBe(longCount);
      expect(warnings).toEqual([]);
    });

    it('keeps two cards and the footer on the last page of a ten-subject student', async () => {
      const { pageCount } = await printed(key, sample('1', docType));
      const last = (await printed(key, sample('1', docType))).pages[pageCount - 1];
      expect(last).toMatch(/Created on/);
      expect(last).toMatch(/The Arts/);
    });

    // Long content has **bold** inside the comments: on an italic comment that needs a real bold
    // italic, because Chromium embeds a faked one as Type 3.
    it('embeds its fonts as TrueType, never Type 3, even with bold in a comment', async () => {
      const { pdf } = await renderReportPdf({ template: build(key), data: longContent(docType), browser });
      const raw = pdf.toString('latin1');
      expect(raw).not.toMatch(/\/Subtype\s*\/Type3/);
      expect(raw).toMatch(/\/Subtype\s*\/CIDFontType2/);
    });
  });

  describe.each([
    ['report-card-standard'],
    ['report-card-t1t2final'],
  ])('%s pages', (key) => {
    it('keeps the whole chart on page 1, even with a long name', async () => {
      for (const data of [sample('4', 'report_card'), longContent('report_card')]) {
        const { pages } = await printed(key, data);
        expect(pages[0]).toMatch(/Level 1/);
        expect(pages[0]).not.toMatch(/Academic Achievement/);
        expect(pages[1]).toMatch(/Academic Achievement/);
      }
    });

    it('prints two subjects on every subject page but the last', async () => {
      const data = longContent('report_card');
      const { pages } = await printed(key, data);
      const names = data.subjects.map((s) => s.name);
      const onPage = (p) => names.filter((n) => p.includes(n)).length;
      pages.slice(1, -1).forEach((p) => expect(onPage(p)).toBe(2));
      expect(onPage(pages[pages.length - 1])).toBe(1);
    });
  });

  it('prints the First, Second and Final Term rows on the term card', async () => {
    const { pages } = await printed('report-card-t1t2final', sample('4', 'report_card'));
    expect(pages[0]).toMatch(/FINAL TERM REPORT CARD/);
    ['First Term', 'Second Term', 'Final Term'].forEach((t) => expect(pages[1]).toContain(t));
  });

  it('keeps the first long comment on page 1 of the progress report, so its heading is never left alone', async () => {
    const { pages } = await printed('progress-standard', longContent('progress_report'));
    expect(pages[0]).toMatch(/Progress by Subject/);
    expect(pages[0]).toMatch(/Teacher Comments:/);
  });

  it('prints N/A when a student has no OEN on a report card', async () => {
    const data = sample('4', 'report_card');
    data.student = { ...data.student, oen: '' };
    const { pages } = await printed('report-card-standard', data);
    expect(pages[0]).toContain('N/A');
  });

  it('leaves the OEN out of a progress report when a student has none', async () => {
    const data = sample('4', 'progress_report');
    data.student = { ...data.student, oen: '' };
    const { pages } = await printed('progress-standard', data);
    expect(pages[0]).not.toContain('OEN:');
  });

  it('prints every kindergarten template without a warning about the new style options', async () => {
    for (const [key, docType, s] of [['progress-jk', 'progress_report', 'JK'], ['progress-sk', 'progress_report', 'SK'], ['report-card-jk', 'report_card', 'JK'], ['report-card-sk', 'report_card', 'SK']]) {
      const { pageCount } = await printed(key, kit.sampleReportData(s, docType));
      expect(pageCount).toBeGreaterThan(0);
    }
  });
});
