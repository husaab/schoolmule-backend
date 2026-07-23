// services/agendaAssembler.js
//
// Assembles the final print-ready agenda PDF:
//   1. Compute the page sequence (same manifest the live preview uses).
//   2. Render generated pages with Puppeteer, chunked one document per
//      month on a shared browser (~10 renders instead of ~100).
//   3. Merge everything in sequence order with pdf-lib (uploaded PDFs
//      copied page-by-page, images placed full-bleed on Letter pages).
//   4. Upload to the 'agendas' bucket.
//
// Page-count determinism is asserted after every chunk render: a template
// overflowing onto an extra page would shift all printed page numbers, so
// we fail loudly instead of shipping a misnumbered book.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const supabase = require('../config/supabaseClient');
const { resolveTheme } = require('../templates/agendaBaseTemplate');
const logger = require('../logger');
const { createPDFBuffer, launchPDFBrowser } = require('../utils/pdfGenerator');
const agendaComposer = require('./agendaComposer');
const { academicMonthSequence } = require('../utils/agendaCalendar');

const AGENDA_BUCKET = 'agendas';

// Assembled PDFs are kept on local disk and streamed to the browser on
// download — storing them in Supabase would hit the free plan's 50MB
// object limit. The directory is ephemeral (survives until restart /
// redeploy); the download endpoint asks for a regenerate if it's gone.
const OUTPUT_DIR = path.join(os.tmpdir(), 'schoolmule-agendas');

function generatedPdfPath(agendaId) {
  return path.join(OUTPUT_DIR, `${agendaId}.pdf`);
}

const LETTER_WIDTH = 612;
const LETTER_HEIGHT = 792;

/**
 * Placement of an embedded image on a Letter page.
 * Baseline: 'cover' fills the page edge-to-edge (crops overflow);
 * 'contain' fits the whole image (white margins if aspect differs).
 * On top of that: zoom multiplies the base scale, and offsets shift the
 * image from center as fractions of the page size (+x right, +y down).
 * The preview's ImagePageView mirrors this math exactly.
 */
function placeImage(image, { fitMode, zoom = 1, zoomY = null, offsetX = 0, offsetY = 0 } = {}) {
  const baseScale = fitMode === 'cover'
    ? Math.max(LETTER_WIDTH / image.width, LETTER_HEIGHT / image.height)
    : Math.min(LETTER_WIDTH / image.width, LETTER_HEIGHT / image.height);
  // zoomY = null means uniform scaling; a number stretches the vertical
  // axis independently (side-handle resize in the editor)
  const width = image.width * baseScale * zoom;
  const height = image.height * baseScale * (zoomY ?? zoom);
  return {
    x: (LETTER_WIDTH - width) / 2 + offsetX * LETTER_WIDTH,
    // PDF y-axis points up; +offsetY means "down the page"
    y: (LETTER_HEIGHT - height) / 2 - offsetY * LETTER_HEIGHT,
    width,
    height,
  };
}

/** '#f5ecd9' -> pdf-lib rgb() color. */
function hexToRgb(hex) {
  let value = hex.slice(1);
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  return rgb(
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255
  );
}

// Page-number chip stamped on uploaded custom pages (bottom-right,
// matching the generated footer's number position). A soft white chip
// keeps the number readable on dark or busy designs. The live preview
// overlays the identical chip using these same metrics.
const STAMP = {
  fontSize: 9,
  paddingX: 6,
  height: 15,
  marginRight: 30, // from right page edge, pt
  marginBottom: 18, // from bottom page edge, pt
};

/** Stamp the global page number on a copied page (any page size). */
function stampPageNumber(page, font, pageNumber, style = {}) {
  const { width } = page.getSize();
  const text = String(pageNumber);
  const textWidth = font.widthOfTextAtSize(text, STAMP.fontSize);
  const chipWidth = textWidth + STAMP.paddingX * 2;
  const x = width - STAMP.marginRight - chipWidth;
  const y = STAMP.marginBottom;

  page.drawRectangle({
    x,
    y,
    width: chipWidth,
    height: STAMP.height,
    color: hexToRgb(style.background || '#ffffff'),
    opacity: style.opacity !== undefined ? style.opacity : 0.82,
  });
  page.drawText(text, {
    x: x + STAMP.paddingX,
    y: y + (STAMP.height - STAMP.fontSize) / 2 + 1,
    size: STAMP.fontSize,
    font,
    color: hexToRgb(style.textColor || '#262626'),
  });
}

async function downloadFromStorage(filePath) {
  const { data, error } = await supabase.storage.from(AGENDA_BUCKET).download(filePath);
  if (error) {
    throw new Error(`Failed to download ${filePath} from storage: ${error.message}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Build the complete agenda PDF and upload it.
 * Returns { filePath, pageCount }.
 */
async function assembleAgenda(agendaId) {
  const bundle = await agendaComposer.loadAgendaBundle(agendaId);
  if (!bundle) throw new Error('Agenda not found');
  const { agenda } = bundle;

  const manifest = agendaComposer.computeSequence(bundle);
  if (manifest.totalPages === 0) throw new Error('Agenda has no pages to generate');

  // ---- Render pass: one Puppeteer document per month, shared browser ----
  const monthSeq = academicMonthSequence(
    agenda.academic_year,
    agenda.start_month,
    agenda.end_month
  );

  const chunkByMonth = new Map(); // month -> { pdf: PDFDocument, cursor: 0 }
  const browser = await launchPDFBrowser();
  try {
    for (const { month } of monthSeq) {
      const { html, expectedPageCount } = agendaComposer.renderMonthDocument(bundle, manifest, month);
      if (expectedPageCount === 0) continue;

      const buffer = await createPDFBuffer(html, {
        format: 'Letter',
        margin: { top: 0, bottom: 0, left: 0, right: 0 },
        preferCSSPageSize: true,
        browser,
      });

      const chunkPdf = await PDFDocument.load(buffer);
      if (chunkPdf.getPageCount() !== expectedPageCount) {
        throw new Error(
          `Month ${month} rendered ${chunkPdf.getPageCount()} pages but ${expectedPageCount} were expected — ` +
          'a template likely overflowed its fixed page height. Generation aborted to protect page numbering.'
        );
      }
      chunkByMonth.set(month, { pdf: chunkPdf, cursor: 0 });
    }
  } finally {
    await browser.close();
  }

  // ---- Merge pass: walk the manifest in order ----
  // CRITICAL: pdf-lib dedupes shared objects (fonts, images) only WITHIN a
  // single copyPages call — copying pages one at a time duplicates every
  // shared resource once per page and balloons the output several-fold.
  // So consecutive pages from the same source document are batched into
  // one copyPages call.
  const output = await PDFDocument.create();
  const sourceCache = new Map(); // pageId -> PDFDocument (custom PDFs loaded once)
  const stampFont = await output.embedFont(StandardFonts.Helvetica);

  const sourceKeyOf = (item) => {
    if (item.kind !== 'custom') return `month:${item.month}`;
    return item.fileType === 'pdf' ? `pdf:${item.pageId}` : `img:${item.pageId}:${item.sourcePageIndex}`;
  };

  // Group consecutive manifest items sharing a source document
  const runs = [];
  for (const item of manifest.items) {
    const sourceKey = sourceKeyOf(item);
    const last = runs[runs.length - 1];
    if (last && last.sourceKey === sourceKey) {
      last.items.push(item);
    } else {
      runs.push({ sourceKey, items: [item] });
    }
  }

  for (const run of runs) {
    const first = run.items[0];

    if (first.kind === 'custom' && first.fileType === 'image') {
      // Embed the original upload byte-for-byte — no re-encoding, no
      // quality loss. Size is a non-issue since the final PDF is streamed
      // from local disk rather than stored in Supabase.
      const buffer = await downloadFromStorage(first.filePath);
      const background = resolveTheme(agenda.theme).background;
      const isPng = first.filePath.toLowerCase().endsWith('.png') ||
        (first.mimeType || '').includes('png');
      const image = isPng ? await output.embedPng(buffer) : await output.embedJpg(buffer);
      const page = output.addPage([LETTER_WIDTH, LETTER_HEIGHT]);
      // Theme background behind the image so Fit-mode margins match
      // the generated pages (preview mirrors this)
      page.drawRectangle({
        x: 0, y: 0, width: LETTER_WIDTH, height: LETTER_HEIGHT,
        color: hexToRgb(background),
      });
      page.drawImage(image, placeImage(image, first));
      if (first.stampNumber) stampPageNumber(page, stampFont, first.pageNumber, first.stampStyle);
      continue;
    }

    let source;
    let indices;
    if (first.kind === 'custom') {
      source = sourceCache.get(first.pageId);
      if (!source) {
        const buffer = await downloadFromStorage(first.filePath);
        source = await PDFDocument.load(buffer, { ignoreEncryption: true });
        sourceCache.set(first.pageId, source);
      }
      indices = run.items.map((item) => item.sourcePageIndex);
      const maxIndex = Math.max(...indices);
      if (maxIndex >= source.getPageCount()) {
        throw new Error(
          `Custom page "${first.title}" expected page ${maxIndex + 1} but the PDF has ${source.getPageCount()} pages`
        );
      }
    } else {
      const chunk = chunkByMonth.get(first.month);
      if (!chunk) throw new Error(`No rendered chunk for month ${first.month}`);
      source = chunk.pdf;
      indices = run.items.map(() => chunk.cursor++);
    }

    const copied = await output.copyPages(source, indices);
    copied.forEach((page, i) => {
      output.addPage(page);
      const item = run.items[i];
      if (item.kind === 'custom' && item.stampNumber) {
        stampPageNumber(page, stampFont, item.pageNumber, item.stampStyle);
      }
    });
  }

  const finalPageCount = output.getPageCount();
  if (finalPageCount !== manifest.totalPages) {
    throw new Error(
      `Assembled ${finalPageCount} pages but the manifest expected ${manifest.totalPages}`
    );
  }

  // ---- Store pass: local disk, streamed on download (no Supabase) ----
  const outputBytes = await output.save();
  const sizeMb = (outputBytes.length / 1024 / 1024).toFixed(1);

  const filePath = generatedPdfPath(agendaId);
  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.promises.writeFile(filePath, Buffer.from(outputBytes));

  logger.info(`Assembled agenda ${agendaId}: ${finalPageCount} pages, ${sizeMb}MB -> ${filePath}`);
  return { filePath, pageCount: finalPageCount };
}

module.exports = { assembleAgenda, generatedPdfPath };
