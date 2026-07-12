const puppeteer = require('puppeteer');

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

async function createPDFBuffer(html, options = {}) {
  const {
    format = 'A4',
    landscape = false,
    margin = { top: '40px', bottom: '40px', left: '40px', right: '40px' },
    preferCSSPageSize = false,
    browser: sharedBrowser = null,
  } = options;

  // Without a shared browser this launches (and closes) its own —
  // the original per-call behavior. With one, only a page is created,
  // so bulk flows pay a single Chromium launch.
  const ownBrowser = !sharedBrowser;
  const browser = sharedBrowser || await puppeteer.launch(LAUNCH_OPTIONS);

  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });

    return await page.pdf({
      format,
      landscape,
      printBackground: true,
      margin,
      preferCSSPageSize,
    });
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
