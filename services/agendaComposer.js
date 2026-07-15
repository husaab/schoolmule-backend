// services/agendaComposer.js
//
// The agenda's shared brain: computes the deterministic page sequence
// (the "manifest") and renders any generated page's HTML. Both the live
// preview endpoints and the PDF assembler consume this, so what the
// editor shows is exactly what prints.
//
// Every generated page is one fixed-size 8.5x11in block (= one PDF page),
// and every uploaded custom page's page_count is stored at upload time,
// so global page numbers are computable before any rendering happens.

const db = require('../config/database');
const agendaQueries = require('../queries/agenda.queries');
const schoolCalendarQueries = require('../queries/schoolCalendar.queries');
const {
  academicMonthSequence,
  academicYearToRange,
  schoolWeeksForMonth,
} = require('../utils/agendaCalendar');
const { wrapAgendaDocument } = require('./../templates/agendaBaseTemplate');
const { getMonthOverviewPageHTML, MONTH_OVERVIEW_CSS } = require('../templates/agendaMonthOverviewTemplate');
const { getWeeklyPageHTML, WEEKLY_CSS } = require('../templates/agendaWeeklyTemplate');
const { getNotesPageHTML, NOTES_CSS } = require('../templates/agendaNotesTemplate');
const { getEvaluationPageHTML, EVALUATION_CSS } = require('../templates/agendaEvaluationTemplate');

const ALL_AGENDA_CSS = [MONTH_OVERVIEW_CSS, WEEKLY_CSS, NOTES_CSS, EVALUATION_CSS].join('\n');

/**
 * Load everything needed to compose an agenda:
 * agenda row + months config + custom pages + calendar events for the year.
 * Returns null if the agenda doesn't exist.
 */
async function loadAgendaBundle(agendaId) {
  const { rows: agendaRows } = await db.query(agendaQueries.selectAgendaById, [agendaId]);
  if (agendaRows.length === 0) return null;
  const agenda = agendaRows[0];

  const [{ rows: months }, { rows: customPages }] = await Promise.all([
    db.query(agendaQueries.selectAgendaMonths, [agendaId]),
    db.query(agendaQueries.selectCustomPages, [agendaId]),
  ]);

  const range = academicYearToRange(agenda.academic_year);
  const { rows: events } = await db.query(
    schoolCalendarQueries.selectEventsBySchoolAndRange,
    [agenda.school, range.from, range.to]
  );

  return { agenda, months, customPages, events };
}

/** Calendar events overlapping a given month, mapped to template shape. */
function eventsForMonth(events, year, month) {
  const pad = (n) => String(n).padStart(2, '0');
  const monthStart = `${year}-${pad(month)}-01`;
  const monthEnd = `${year}-${pad(month)}-31`;
  return events
    .filter((e) => {
      const start = toIso(e.start_date);
      const end = toIso(e.end_date) || start;
      return start <= monthEnd && end >= monthStart;
    })
    .map((e) => ({
      title: e.title,
      startDate: toIso(e.start_date),
      endDate: toIso(e.end_date),
      isSchoolClosed: e.is_school_closed,
    }));
}

/** pg returns DATE columns as JS Dates; normalize to YYYY-MM-DD strings. */
function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * Compute the full page sequence with global page numbers.
 *
 * Returns { totalPages, items } where each item is exactly ONE output page:
 *  - custom pages expand to one item per source page (sourcePageIndex)
 *  - generated kinds: 'monthOverview' | 'weekly' | 'notes' | 'evaluation'
 * Every item has: seq (1-based), kind, pageNumber (= seq), numbered
 * (false for custom pages — externally designed pages carry no number).
 */
function computeSequence({ agenda, months, customPages }) {
  const monthSeq = academicMonthSequence(
    agenda.academic_year,
    agenda.start_month,
    agenda.end_month
  );
  const monthNumbersInRange = new Set(monthSeq.map((m) => m.month));

  const slots = { intro: [], month: new Map(), closing: [] };
  for (const page of customPages) {
    if (page.anchor === 'month') {
      // Pages anchored to a month outside the agenda's range are held out
      // of the book (kept in DB so shrinking/expanding the range is lossless).
      if (!monthNumbersInRange.has(page.anchor_month)) continue;
      if (!slots.month.has(page.anchor_month)) slots.month.set(page.anchor_month, []);
      slots.month.get(page.anchor_month).push(page);
    } else {
      slots[page.anchor].push(page);
    }
  }

  const quotesByMonth = new Map(months.map((m) => [m.month, Array.isArray(m.quotes) ? m.quotes : []]));

  const items = [];
  const pushCustom = (pages) => {
    for (const page of pages) {
      for (let i = 0; i < page.page_count; i++) {
        items.push({
          kind: 'custom',
          pageId: page.page_id,
          title: page.title,
          fileType: page.file_type,
          filePath: page.file_path,
          mimeType: page.mime_type,
          fitMode: page.fit_mode || 'contain',
          zoom: page.zoom !== undefined ? Number(page.zoom) : 1,
          zoomY: page.zoom_y !== undefined && page.zoom_y !== null ? Number(page.zoom_y) : null,
          offsetX: page.offset_x !== undefined ? Number(page.offset_x) : 0,
          offsetY: page.offset_y !== undefined ? Number(page.offset_y) : 0,
          sourcePageIndex: i,
          sourcePageCount: page.page_count,
          anchor: page.anchor,
          anchorMonth: page.anchor_month,
          numbered: false,
        });
      }
    }
  };

  pushCustom(slots.intro);

  for (const { year, month } of monthSeq) {
    pushCustom(slots.month.get(month) || []);
    items.push({ kind: 'monthOverview', year, month, numbered: true });

    const weeks = schoolWeeksForMonth(year, month);
    const quotes = quotesByMonth.get(month) || [];
    weeks.forEach((week, weekIndex) => {
      items.push({
        kind: 'weekly',
        year,
        month,
        week,
        weekIndex,
        quote: quotes.length > 0 ? quotes[weekIndex % quotes.length] : '',
        numbered: true,
      });
      if (agenda.include_notes_page) {
        items.push({ kind: 'notes', year, month, weekIndex, numbered: true });
      }
    });

    items.push({ kind: 'evaluation', year, month, numbered: true });
  }

  pushCustom(slots.closing);

  items.forEach((item, index) => {
    item.seq = index + 1;
    item.pageNumber = index + 1;
  });

  return { totalPages: items.length, items };
}

/**
 * Render one generated (non-custom) manifest item to its inner .page HTML.
 */
function renderGeneratedPage(bundle, item) {
  const { agenda, events } = bundle;
  const footerText = agenda.footer_text || '';

  switch (item.kind) {
    case 'monthOverview':
      return getMonthOverviewPageHTML({
        year: item.year,
        month: item.month,
        events: eventsForMonth(events, item.year, item.month),
        footerText,
        pageNumber: item.pageNumber,
      });
    case 'weekly':
      return getWeeklyPageHTML({
        year: item.year,
        month: item.month,
        week: item.week,
        quote: item.quote,
        closedDays: eventsForMonth(events, item.year, item.month).filter((e) => e.isSchoolClosed),
        footerText,
        pageNumber: item.pageNumber,
      });
    case 'notes':
      return getNotesPageHTML({ footerText, pageNumber: item.pageNumber });
    case 'evaluation':
      return getEvaluationPageHTML({
        subjects: Array.isArray(agenda.evaluation_subjects) ? agenda.evaluation_subjects : [],
        footerText,
        pageNumber: item.pageNumber,
      });
    default:
      throw new Error(`Unknown generated page kind: ${item.kind}`);
  }
}

/**
 * Render a complete standalone HTML document for a single generated page
 * (used by the live preview's iframe srcdoc).
 */
function renderGeneratedPageDocument(bundle, item) {
  return wrapAgendaDocument(renderGeneratedPage(bundle, item), ALL_AGENDA_CSS, bundle.agenda.theme);
}

/**
 * Render one month's generated pages as a single printable HTML document
 * (used by the assembler: one Puppeteer render per month).
 * Returns { html, expectedPageCount }.
 */
function renderMonthDocument(bundle, manifest, month) {
  const monthItems = manifest.items.filter(
    (item) => item.kind !== 'custom' && item.month === month
  );
  const pages = monthItems.map((item) => renderGeneratedPage(bundle, item));
  return {
    html: wrapAgendaDocument(pages, ALL_AGENDA_CSS, bundle.agenda.theme),
    expectedPageCount: monthItems.length,
    items: monthItems,
  };
}

module.exports = {
  loadAgendaBundle,
  computeSequence,
  renderGeneratedPage,
  renderGeneratedPageDocument,
  renderMonthDocument,
  eventsForMonth,
  ALL_AGENDA_CSS,
};
