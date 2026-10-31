/**
 * Print a report through reportkit — the same engine the web designer runs —
 * so the PDF is laid out exactly as the admin saw it.
 *
 * The engine is the committed bundle in vendor/reportkit (built from
 * schoolmule/src/reportkit by `npm run sync:reportkit` in the web repo).
 * Fonts are inlined as data URIs and the page may not touch the network:
 * every image must already be a data URI (see inlineAssets).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const puppeteer = require('puppeteer');
const logger = require('../../logger');

const VENDOR_DIR = path.join(__dirname, '..', '..', 'vendor', 'reportkit');

// Unhinted glyph metrics match the designer's (macOS/Chrome) text widths, so
// lines wrap — and pages break — in the same places.
const LAUNCH_OPTIONS = {
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none', '--disable-lcd-text'],
};

let vendorCache = null;

/** The bundle, its manifest, the font CSS and a Node copy of the engine's pure helpers. */
function vendor() {
  if (vendorCache) return vendorCache;
  const code = fs.readFileSync(path.join(VENDOR_DIR, 'reportkit.iife.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'manifest.json'), 'utf8'));
  // The bundle touches no DOM at load, so Node can use its pure parts
  // (defaults, sample data, conditions, mark formatting).
  const sandbox = {};
  vm.runInNewContext(`${code};this.ReportKit = ReportKit;`, sandbox);
  const kit = sandbox.ReportKit;
  const fontCss = kit.fontFaceCss((file) => {
    const buf = fs.readFileSync(path.join(VENDOR_DIR, 'fonts', file));
    return `data:font/woff2;base64,${buf.toString('base64')}`;
  });
  vendorCache = { code, manifest, kit, fontCss };
  return vendorCache;
}

/** The engine's pure exports in Node (DEFAULT_TEMPLATES, sampleReportData, formatMark…). */
function reportKit() {
  return vendor().kit;
}

function engineVersion() {
  return vendor().manifest.engineVersion;
}

async function launchReportBrowser() {
  return puppeteer.launch(LAUNCH_OPTIONS);
}

function pageSizeOf(template) {
  return vendor().kit.PAGE_SIZES[template?.page?.size] || vendor().kit.PAGE_SIZES.letter;
}

function shellHtml(size) {
  const { code, fontCss } = vendor();
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>@page{size:${size.width}px ${size.height}px;margin:0}html,body{margin:0;padding:0;background:#fff}</style>
<style>${fontCss}</style>
<script>${code}</script>
</head><body><div id="rk"></div></body></html>`;
}

/**
 * Lay the report out in a fresh page of `browser`. Returns the page (caller
 * closes it) and the engine's result ({ pageCount, warnings, pageSize }).
 */
async function layout(browser, template, data) {
  const size = pageSizeOf(template);
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.startsWith('data:') || url.startsWith('about:')) req.continue();
      else req.abort();
    });
    await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
    await page.setContent(shellHtml(size), { waitUntil: 'load' });
    const result = await page.evaluate(async (doc, reportData) => {
      // eslint-disable-next-line no-undef
      const r = await ReportKit.renderReport(document.getElementById('rk'), doc, reportData, { mode: 'print' });
      await Promise.all([...document.images].map((img) => (img.decode ? img.decode().catch(() => {}) : null)));
      return r;
    }, template, data);
    return { page, result, size };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

/**
 * Render a report to a PDF buffer.
 * @param {object} opts
 * @param {object} opts.template  TemplateDoc
 * @param {object} opts.data      ReportData (assets already data URIs)
 * @param {object} [opts.browser] shared browser for bulk runs
 * @returns {Promise<{pdf: Buffer, pageCount: number, warnings: object[], engineVersion: number}>}
 */
async function renderReportPdf({ template, data, browser = null }) {
  const own = !browser;
  const b = browser || (await launchReportBrowser());
  try {
    const { page, result, size } = await layout(b, template, data);
    try {
      const pdf = await page.pdf({
        width: `${size.width}px`,
        height: `${size.height}px`,
        printBackground: true,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        preferCSSPageSize: true,
      });
      return { pdf: Buffer.from(pdf), pageCount: result.pageCount, warnings: result.warnings, engineVersion: engineVersion() };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    if (own) await b.close().catch(() => {});
  }
}

/** PNG screenshots of every page (visual tests and previews). */
async function renderReportPngs({ template, data, browser = null, scale = 1 }) {
  const own = !browser;
  const b = browser || (await launchReportBrowser());
  try {
    const { page, result } = await layout(b, template, data);
    try {
      if (scale !== 1) await page.setViewport({ width: result.pageSize.width, height: result.pageSize.height, deviceScaleFactor: scale });
      const handles = await page.$$('.rk-page');
      const pngs = [];
      for (const h of handles) pngs.push(Buffer.from(await h.screenshot({ type: 'png' })));
      return { pngs, pageCount: result.pageCount, warnings: result.warnings };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    if (own) await b.close().catch(() => {});
  }
}

/** Every page's text in order (parity tests). */
async function renderReportText({ template, data, browser = null }) {
  const own = !browser;
  const b = browser || (await launchReportBrowser());
  try {
    const { page, result } = await layout(b, template, data);
    try {
      const pages = await page.$$eval('.rk-page', (els) => els.map((el) => el.innerText));
      return { pages, pageCount: result.pageCount, warnings: result.warnings };
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    if (own) await b.close().catch(() => {});
  }
}

/**
 * Replace image URLs in data.assets with data URIs (the print page has no
 * network). Unreachable images become null and the report prints without them.
 */
async function inlineAssets(data, { timeoutMs = 8000 } = {}) {
  const assets = { ...(data.assets || {}) };
  await Promise.all(
    Object.entries(assets).map(async ([key, url]) => {
      if (!url || typeof url !== 'string' || url.startsWith('data:')) return;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = res.headers.get('content-type') || 'image/png';
        const buf = Buffer.from(await res.arrayBuffer());
        assets[key] = `data:${type};base64,${buf.toString('base64')}`;
      } catch (err) {
        logger.warn({ err: err.message, asset: key }, 'Could not inline a report image');
        assets[key] = null;
      }
    }),
  );
  return { ...data, assets };
}

module.exports = {
  renderReportPdf,
  renderReportPngs,
  renderReportText,
  launchReportBrowser,
  inlineAssets,
  reportKit,
  engineVersion,
  VENDOR_DIR,
};
