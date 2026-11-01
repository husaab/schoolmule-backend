/**
 * Prints through the real bundled engine in headless Chromium (no database):
 * regressions a page-count check can't see.
 */
const { reportKit, renderReportText, renderReportPdf, launchReportBrowser } = require('../../../../services/reportEngine/render');

jest.setTimeout(60000);

describe('report engine (real Chromium)', () => {
  let browser;
  beforeAll(async () => {
    browser = await launchReportBrowser();
  });
  afterAll(async () => {
    if (browser) await browser.close();
  });

  const kit = reportKit();
  const skDoc = () => kit.DEFAULT_TEMPLATES.find((d) => d.key === 'progress-sk').build();
  const data = kit.sampleReportData('SK', 'progress_report');

  it('prints a table kept together on one page with all of its rows', async () => {
    const doc = skDoc();
    const skills = doc.blocks.find((b) => b.type === 'skillsTable');
    skills.keepTogether = true;
    skills.includeGroups = ['Mathematics'];
    const { pages } = await renderReportText({ template: doc, data, browser });
    const text = pages.join('\n');
    expect(text).toContain('Counts to 100 by ones and tens');
    expect(text).toContain('Builds and draws shapes');
  });

  it('prints a table with no rows as its heading, not as nothing', async () => {
    const doc = skDoc();
    const comments = doc.blocks.find((b) => b.type === 'commentsTable');
    comments.showEmptyRows = false;
    comments.hideWhenEmpty = false;
    const empty = { ...data, comments: [] };
    const { pages } = await renderReportText({ template: doc, data: empty, browser });
    expect(pages.join('\n')).toContain('Strengths/Next Steps for Improvement');
  });

  it('prints markup typed into a template or a comment as text', async () => {
    const doc = skDoc();
    doc.blocks.unshift({ id: 'xss', type: 'text', text: '<img src=x onerror="document.title=1">{{student.firstName}}' });
    const evil = { ...data, comments: [{ key: 'k', label: 'Art', caption: '', text: '<script>document.title=2</script>' }] };
    const { pages } = await renderReportText({ template: doc, data: evil, browser });
    const text = pages.join('\n');
    expect(text).toContain('<img src=x onerror="document.title=1">Sara');
    expect(text).toContain('<script>document.title=2</script>');
  });

  it('never loads a remote image a template points at', async () => {
    const doc = skDoc();
    doc.header.elements.push({ id: 'remote', type: 'image', x: 0, y: 0, w: 10, h: 10, src: { kind: 'url', url: 'http://169.254.169.254/x.png' } });
    expect(kit.validateTemplate(doc).ok).toBe(false);
    // Even unvalidated, the engine resolves it to nothing and the page has no network.
    const { pdf } = await renderReportPdf({ template: doc, data, browser });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
