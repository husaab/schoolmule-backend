const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');

// Shared launch config — helps when deploying to Vercel or Docker.
const LAUNCH_OPTIONS = {
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
};

// Launch a browser for callers that render many PDFs in one flow
// (e.g. bulk report cards). Pass it to createPDFBuffer via
// options.browser and close it yourself when done.
async function launchPDFBrowser() {
  return puppeteer.launch(LAUNCH_OPTIONS);
}

// Chrome needs some element in a header/footer template, even an empty one.
const EMPTY_TEMPLATE = '<span></span>';

// Page furniture (repeating headers/footers). Chrome prints `headerTemplate`
// and `footerTemplate` inside the top/bottom margins of every page; inside
// them `<span class="pageNumber">` and `<span class="totalPages">` are filled
// in. The templates can't load anything over the network, so images and fonts
// in them must be data URIs.
//
// `firstPage: { headerTemplate?, footerTemplate? }` gives page 1 its own
// furniture (a cover page without the running header, say; '' for none).
// Chrome has no per-page templates, so the document is printed twice, once
// with each set, and page 1 of the first-page print is joined to pages 2+ of
// the regular one. Both prints lay out the same HTML at the same size, so
// their pages line up, and page numbers stay those of the whole document.
function chromeFor(headerTemplate, footerTemplate) {
  if (!headerTemplate && !footerTemplate) return {};
  return {
    displayHeaderFooter: true,
    headerTemplate: headerTemplate || EMPTY_TEMPLATE,
    footerTemplate: footerTemplate || EMPTY_TEMPLATE,
  };
}

async function printWithDistinctFirstPage(page, base, options) {
  const { headerTemplate, footerTemplate, firstPage } = options;
  const rest = await page.pdf({ ...base, ...chromeFor(headerTemplate, footerTemplate) });
  const restDoc = await PDFDocument.load(rest);
  const count = restDoc.getPageCount();

  const first = await page.pdf({
    ...base,
    ...chromeFor(
      firstPage.headerTemplate ?? headerTemplate,
      firstPage.footerTemplate ?? footerTemplate,
    ),
    pageRanges: '1',
  });
  const firstDoc = await PDFDocument.load(first);

  const merged = await PDFDocument.create();
  const [cover] = await merged.copyPages(firstDoc, [0]);
  merged.addPage(cover);
  if (count > 1) {
    const indices = Array.from({ length: count - 1 }, (_, i) => i + 1);
    const pages = await merged.copyPages(restDoc, indices);
    pages.forEach((p) => merged.addPage(p));
  }
  return Buffer.from(await merged.save());
}

async function createPDFBuffer(html, options = {}) {
  const {
    format = 'A4',
    landscape = false,
    margin = { top: '40px', bottom: '40px', left: '40px', right: '40px' },
    preferCSSPageSize = false,
    browser: sharedBrowser = null,
    headerTemplate = null,
    footerTemplate = null,
    firstPage = null,
  } = options;

  // Without a shared browser this launches (and closes) its own —
  // the original per-call behavior. With one, only a page is created,
  // so bulk flows pay a single Chromium launch.
  const ownBrowser = !sharedBrowser;
  const browser = sharedBrowser || await puppeteer.launch(LAUNCH_OPTIONS);

  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // A document with its own (data URI) fonts: wait for them to be decoded
    // too, so the first print never lays out with a fallback font.
    if (html.includes('@font-face')) await page.evaluate(() => document.fonts.ready);

    const base = { format, landscape, printBackground: true, margin, preferCSSPageSize };
    if (firstPage) {
      return await printWithDistinctFirstPage(page, base, { headerTemplate, footerTemplate, firstPage });
    }
    return await page.pdf({ ...base, ...chromeFor(headerTemplate, footerTemplate) });
  } finally {
    await page.close();
    if (ownBrowser) await browser.close();
  }
}

// Render many HTML documents to PDF buffers in a SINGLE browser launch.
// Used by batch flows (e.g. certificate emails) where calling
// createPDFBuffer per item would launch one Chromium per document —
// the dominant cost. Returns buffers in the same order as `htmls`.
async function createPDFBuffers(htmls, options = {}) {
  const {
    landscape = false,
    margin = { top: '40px', bottom: '40px', left: '40px', right: '40px' },
    preferCSSPageSize = false,
  } = options;

  if (!Array.isArray(htmls) || htmls.length === 0) return [];

  const browser = await puppeteer.launch(LAUNCH_OPTIONS);

  try {
    const buffers = [];
    for (const html of htmls) {
      const page = await browser.newPage();
      try {
        await page.setContent(html, { waitUntil: 'networkidle0' });
        buffers.push(
          await page.pdf({
            format: 'A4',
            landscape,
            printBackground: true,
            margin,
            preferCSSPageSize,
          }),
        );
      } finally {
        await page.close();
      }
    }
    return buffers;
  } finally {
    await browser.close();
  }
}

module.exports = { createPDFBuffer, createPDFBuffers, launchPDFBrowser };
