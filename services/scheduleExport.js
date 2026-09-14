// Renders a built schedule document (the same `pages` the PDF template takes)
// as PDF, PNG or Word. PDF and PNG share the HTML template so an image looks
// exactly like the printed page; Word is an editable table per page instead,
// since a minute-proportional layout can't survive being edited in Word.

const {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} = require('docx');
const JSZip = require('jszip');
const { buildScheduleHtml, SESSION_COLORS, colorFor, toHHMM } = require('../templates/scheduleTemplate');
const { createPDFBuffer, launchPDFBrowser } = require('../utils/pdfGenerator');

const EXPORT_FORMATS = ['pdf', 'png', 'docx'];

/** Safe for a filename or zip entry. */
const slug = (value) => String(value || 'schedule').replace(/[^\w.-]+/g, '_');

// ─── PDF ─────────────────────────────────────────────────────────────────

const renderPdf = (doc) =>
  createPDFBuffer(buildScheduleHtml(doc), {
    format: 'Letter',
    landscape: true,
    preferCSSPageSize: true,
    margin: { top: 0, bottom: 0, left: 0, right: 0 },
  });

// ─── PNG ─────────────────────────────────────────────────────────────────

// Letter landscape at CSS 96dpi; rendered at 2x so text stays crisp when zoomed.
const PAGE_VIEWPORT = { width: 1056, height: 816, deviceScaleFactor: 2 };

/**
 * One PNG per page. The template's page margin lives in `@page`, which only
 * applies when printing, so the screen render gets the same margin as padding.
 */
const renderPngs = async (doc) => {
  const browser = await launchPDFBrowser();
  try {
    const images = [];
    for (const page of doc.pages) {
      const html = buildScheduleHtml({ ...doc, pages: [page] }).replace(
        '</style>',
        'body { padding: 0.35in; background: #fff; }\n</style>'
      );
      const tab = await browser.newPage();
      try {
        await tab.setViewport(PAGE_VIEWPORT);
        await tab.setContent(html, { waitUntil: 'networkidle0' });
        images.push({ title: page.title, buffer: await tab.screenshot({ type: 'png' }) });
      } finally {
        await tab.close();
      }
    }
    return images;
  } finally {
    await browser.close();
  }
};

// ─── Word ────────────────────────────────────────────────────────────────

const HEADER_FILL = 'F0FDFA';
const TEAL = '0F766E';

// Letter landscape in twips (1/1440 in) with half-inch-ish margins. Widths are
// absolute: percentage-only tables collapse to slivers in some Word viewers.
const PAGE_MARGIN = 504;
const CONTENT_WIDTH = 15840 - 2 * PAGE_MARGIN;
const TIME_COLUMN_WIDTH = 1700;

/**
 * Rows of the table: every distinct start–end pair on the page, in time order.
 * Staggered bells (Grade 1 at 9:00, Grade 5 at 9:05) get rows of their own
 * rather than being merged into a slot that misstates someone's times.
 */
const timeSlots = (columns) => {
  const seen = new Map();
  for (const col of columns) {
    for (const s of col.sessions) seen.set(`${s.startMin}-${s.endMin}`, { startMin: s.startMin, endMin: s.endMin });
  }
  return [...seen.values()].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
};

const headerCell = (text, width) =>
  new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: HEADER_FILL },
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, bold: true })] }),
    ],
  });

const sessionParagraphs = (s) => [
  new Paragraph({ children: [new TextRun({ text: s.primaryLabel, bold: true })] }),
  ...(s.secondaryLabel ? [new Paragraph({ children: [new TextRun({ text: s.secondaryLabel, size: 18 })] })] : []),
  ...(s.roomName
    ? [new Paragraph({ children: [new TextRun({ text: s.roomName, size: 16, italics: true, color: '4B5563' })] })]
    : []),
];

const pageTable = (page) => {
  const timeWidth = TIME_COLUMN_WIDTH;
  const colWidth = Math.floor((CONTENT_WIDTH - timeWidth) / Math.max(page.columns.length, 1));

  const header = new TableRow({
    tableHeader: true,
    children: [headerCell('Time', timeWidth), ...page.columns.map((c) => headerCell(c.label, colWidth))],
  });

  const rows = timeSlots(page.columns).map(
    (slot) =>
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: timeWidth, type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: `${toHHMM(slot.startMin)}–${toHHMM(slot.endMin)}`, size: 18, color: '4B5563' }),
                ],
              }),
            ],
          }),
          ...page.columns.map((col) => {
            const here = col.sessions.filter((s) => s.startMin === slot.startMin && s.endMin === slot.endMin);
            return new TableCell({
              width: { size: colWidth, type: WidthType.DXA },
              // A single class keeps its PDF colour; an empty or shared slot stays white.
              shading:
                here.length === 1
                  ? { type: ShadingType.CLEAR, color: 'auto', fill: colorFor(here[0].primaryLabel, SESSION_COLORS).slice(1) }
                  : undefined,
              children: here.length ? here.flatMap(sessionParagraphs) : [new Paragraph('')],
            });
          }),
        ],
      })
  );

  return new Table({
    width: { size: timeWidth + colWidth * page.columns.length, type: WidthType.DXA },
    columnWidths: [timeWidth, ...page.columns.map(() => colWidth)],
    layout: TableLayoutType.FIXED,
    rows: [header, ...rows],
  });
};

const renderDocx = (doc) =>
  Packer.toBuffer(
    new Document({
      creator: 'SchoolMule',
      title: doc.scheduleName,
      styles: { default: { document: { run: { font: 'Arial', size: 20 } } } },
      sections: doc.pages.map((page) => ({
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE, width: 12240, height: 15840 },
            margin: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
          },
        },
        children: [
          new Paragraph({ children: [new TextRun({ text: doc.schoolName, bold: true, size: 28, color: TEAL })] }),
          new Paragraph({ children: [new TextRun({ text: doc.scheduleName, size: 20, color: '6B7280' })] }),
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 160 },
            children: [new TextRun({ text: page.title, bold: true, size: 36, color: '1F2937' })],
          }),
          pageTable(page),
        ],
      })),
    })
  );

// ─── Entry point ─────────────────────────────────────────────────────────

/**
 * doc: { schoolName, scheduleName, pages, rangeStartMin, rangeEndMin }
 * Returns { buffer, contentType, filename, inline }. A multi-page PNG export
 * becomes a zip of one image per page; a single page is a plain .png.
 */
const renderScheduleExport = async (doc, format, baseName) => {
  const base = slug(baseName);
  if (format === 'png') {
    const images = await renderPngs(doc);
    if (images.length === 1) {
      return { buffer: images[0].buffer, contentType: 'image/png', filename: `${base}.png`, inline: false };
    }
    const zip = new JSZip();
    images.forEach((img, i) => zip.file(`${String(i + 1).padStart(2, '0')}_${slug(img.title)}.png`, img.buffer));
    return {
      buffer: await zip.generateAsync({ type: 'nodebuffer' }),
      contentType: 'application/zip',
      filename: `${base}.zip`,
      inline: false,
    };
  }
  if (format === 'docx') {
    return {
      buffer: await renderDocx(doc),
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${base}.docx`,
      inline: false,
    };
  }
  return { buffer: await renderPdf(doc), contentType: 'application/pdf', filename: `${base}.pdf`, inline: true };
};

/** Writes an export to the response; 400s on an unknown format. */
const sendScheduleExport = async (res, doc, format = 'pdf', baseName) => {
  if (!EXPORT_FORMATS.includes(format)) {
    return res.status(400).json({ status: 'failed', message: `format must be one of ${EXPORT_FORMATS.join(', ')}` });
  }
  const file = await renderScheduleExport(doc, format, baseName);
  res.set('Content-Type', file.contentType);
  res.set('Content-Disposition', `${file.inline ? 'inline' : 'attachment'}; filename="${file.filename}"`);
  return res.send(file.buffer);
};

module.exports = { EXPORT_FORMATS, renderScheduleExport, sendScheduleExport };
