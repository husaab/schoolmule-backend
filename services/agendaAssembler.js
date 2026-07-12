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

const { PDFDocument } = require('pdf-lib');
const supabase = require('../config/supabaseClient');
const logger = require('../logger');
const { createPDFBuffer, launchPDFBrowser } = require('../utils/pdfGenerator');
const agendaComposer = require('./agendaComposer');
const { academicMonthSequence } = require('../utils/agendaCalendar');

const AGENDA_BUCKET = 'agendas';

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
  const output = await PDFDocument.create();
  const sourceCache = new Map(); // pageId -> PDFDocument (custom PDFs loaded once)

  for (const item of manifest.items) {
    if (item.kind === 'custom') {
      if (item.fileType === 'pdf') {
        let source = sourceCache.get(item.pageId);
        if (!source) {
          const buffer = await downloadFromStorage(item.filePath);
          source = await PDFDocument.load(buffer, { ignoreEncryption: true });
          sourceCache.set(item.pageId, source);
        }
        if (item.sourcePageIndex >= source.getPageCount()) {
          throw new Error(
            `Custom page "${item.title}" expected page ${item.sourcePageIndex + 1} but the PDF has ${source.getPageCount()} pages`
          );
        }
        const [copied] = await output.copyPages(source, [item.sourcePageIndex]);
        output.addPage(copied);
      } else {
        const buffer = await downloadFromStorage(item.filePath);
        const isPng = item.filePath.toLowerCase().endsWith('.png') ||
          (item.mimeType || '').includes('png');
        const image = isPng ? await output.embedPng(buffer) : await output.embedJpg(buffer);
        const page = output.addPage([LETTER_WIDTH, LETTER_HEIGHT]);
        page.drawImage(image, placeImage(image, item));
      }
    } else {
      const chunk = chunkByMonth.get(item.month);
      if (!chunk) throw new Error(`No rendered chunk for month ${item.month}`);
      const [copied] = await output.copyPages(chunk.pdf, [chunk.cursor]);
      output.addPage(copied);
      chunk.cursor += 1;
    }
  }

  const finalPageCount = output.getPageCount();
  if (finalPageCount !== manifest.totalPages) {
    throw new Error(
      `Assembled ${finalPageCount} pages but the manifest expected ${manifest.totalPages}`
    );
  }

  // ---- Store pass ----
  const outputBytes = await output.save();
  const schoolFolder = String(agenda.school).replace(/\s+/g, '').toUpperCase();
  const filePath = `${schoolFolder}/${agenda.academic_year}/agenda.pdf`;

  const { error: uploadError } = await supabase.storage
    .from(AGENDA_BUCKET)
    .upload(filePath, Buffer.from(outputBytes), {
      contentType: 'application/pdf',
      upsert: true,
    });
  if (uploadError) {
    throw new Error(`Failed to upload assembled agenda: ${uploadError.message}`);
  }

  logger.info(`Assembled agenda ${agendaId}: ${finalPageCount} pages -> ${filePath}`);
  return { filePath, pageCount: finalPageCount };
}

module.exports = { assembleAgenda };
