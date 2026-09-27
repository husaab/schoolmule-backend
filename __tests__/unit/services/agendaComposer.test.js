const { computeSequence, eventsForMonth } = require('../../../services/agendaComposer');
const { academicMonthSequence, schoolWeeksForMonth } = require('../../../utils/agendaCalendar');

// ─── Fixtures ─────────────────────────────────────────────────────────
// A two-month agenda keeps the expected sequence small enough to reason about.
const agenda = { academic_year: '2026-2027', start_month: 9, end_month: 10, include_notes_page: false };

function customPage(overrides) {
  return {
    page_id: 'p-1',
    title: 'Cover',
    file_type: 'pdf',
    file_path: 'agendas/cover.pdf',
    mime_type: 'application/pdf',
    anchor: 'intro',
    anchor_month: null,
    page_count: 1,
    ...overrides,
  };
}

const kinds = (items) => items.map((i) => i.kind);

describe('computeSequence', () => {
  it('lays out overview, weeks and evaluation per month with no custom pages', () => {
    const { totalPages, items } = computeSequence({ agenda, months: [], customPages: [] });
    const sepWeeks = schoolWeeksForMonth(2026, 9).length;
    const octWeeks = schoolWeeksForMonth(2026, 10).length;

    expect(items[0]).toMatchObject({ kind: 'monthOverview', year: 2026, month: 9, numbered: true, seq: 1, pageNumber: 1 });
    expect(kinds(items).filter((k) => k === 'weekly')).toHaveLength(sepWeeks + octWeeks);
    expect(kinds(items).filter((k) => k === 'notes')).toHaveLength(0);
    expect(kinds(items).filter((k) => k === 'evaluation')).toHaveLength(2);
    expect(totalPages).toBe(items.length);
    // seq and pageNumber agree when nothing is excluded
    items.forEach((it, i) => {
      expect(it.seq).toBe(i + 1);
      expect(it.pageNumber).toBe(i + 1);
    });
  });

  it('adds a notes page after each week when include_notes_page is set', () => {
    const { items } = computeSequence({ agenda: { ...agenda, include_notes_page: true }, months: [], customPages: [] });
    const weekly = kinds(items).filter((k) => k === 'weekly').length;
    expect(kinds(items).filter((k) => k === 'notes')).toHaveLength(weekly);
    const firstWeekly = items.findIndex((i) => i.kind === 'weekly');
    expect(items[firstWeekly + 1].kind).toBe('notes');
    expect(items[firstWeekly + 1]).toMatchObject({ year: 2026, month: 9, weekIndex: 0 });
  });

  it('cycles month quotes across weeks and tolerates non-array quotes', () => {
    const months = [
      { month: 9, quotes: ['A', 'B'] },
      { month: 10, quotes: 'not-an-array' },
    ];
    const { items } = computeSequence({ agenda, months, customPages: [] });
    const sep = items.filter((i) => i.kind === 'weekly' && i.month === 9).map((i) => i.quote);
    const oct = items.filter((i) => i.kind === 'weekly' && i.month === 10).map((i) => i.quote);
    expect(sep.slice(0, 3)).toEqual(['A', 'B', 'A']);
    expect(oct.every((q) => q === '')).toBe(true);
  });

  it('places intro pages first, month pages before their overview, closing pages last', () => {
    const customPages = [
      customPage({ page_id: 'closing', anchor: 'closing' }),
      customPage({ page_id: 'oct', anchor: 'month', anchor_month: 10 }),
      customPage({ page_id: 'intro', anchor: 'intro' }),
      // Anchored outside the agenda's range: kept out of the book entirely.
      customPage({ page_id: 'jan', anchor: 'month', anchor_month: 1 }),
    ];
    const { items } = computeSequence({ agenda, months: [], customPages });
    expect(items[0]).toMatchObject({ kind: 'custom', pageId: 'intro', numbered: false });
    expect(items[items.length - 1]).toMatchObject({ kind: 'custom', pageId: 'closing' });
    const octIdx = items.findIndex((i) => i.pageId === 'oct');
    expect(items[octIdx + 1]).toMatchObject({ kind: 'monthOverview', month: 10 });
    expect(items.some((i) => i.pageId === 'jan')).toBe(false);
  });

  it('expands multi-page uploads with absolute source indexes and defaults', () => {
    const customPages = [customPage({ page_count: 2 })];
    const { items } = computeSequence({ agenda, months: [], customPages });
    expect(items[0]).toMatchObject({
      sourcePageIndex: 0, sliceIndex: 0, sourcePageCount: 2,
      fitMode: 'contain', zoom: 1, zoomY: null, offsetX: 0, offsetY: 0,
      anchor: 'intro', anchorMonth: null, excluded: false,
      title: 'Cover', fileType: 'pdf', filePath: 'agendas/cover.pdf', mimeType: 'application/pdf',
    });
    expect(items[1]).toMatchObject({ sourcePageIndex: 1, sliceIndex: 1 });
  });

  it('honours explicit page_from, fit, zoom and offsets (as numbers)', () => {
    const customPages = [customPage({
      page_count: 1, page_from: 3, fit_mode: 'cover', zoom: '1.5', zoom_y: '0.5', offset_x: '10', offset_y: '-4',
    })];
    const { items } = computeSequence({ agenda, months: [], customPages });
    expect(items[0]).toMatchObject({ sourcePageIndex: 3, fitMode: 'cover', zoom: 1.5, zoomY: 0.5, offsetX: 10, offsetY: -4 });
  });

  it('keeps excluded source pages as unnumbered placeholders', () => {
    const customPages = [customPage({ page_count: 3, page_from: 2, excluded_pages: ['3'] })];
    const { totalPages, items } = computeSequence({ agenda, months: [], customPages });
    expect(items.slice(0, 3).map((i) => i.excluded)).toEqual([false, true, false]);
    expect(items[1]).toMatchObject({ seq: 2, pageNumber: null, stampNumber: false });
    expect(items[2]).toMatchObject({ seq: 3, pageNumber: 2 });
    expect(totalPages).toBe(items.length - 1);
  });

  it('treats a non-array excluded_pages as nothing excluded', () => {
    const customPages = [customPage({ excluded_pages: 'oops' })];
    const { items } = computeSequence({ agenda, months: [], customPages });
    expect(items[0].excluded).toBe(false);
  });

  describe('page-number stamps', () => {
    const stampOf = (page, index = 0) => computeSequence({ agenda, months: [], customPages: [page] }).items[index];

    it('defaults to an enabled white chip with dark text', () => {
      expect(stampOf(customPage({}))).toMatchObject({
        stampNumber: true,
        stampStyle: { background: '#ffffff', opacity: 0.82, textColor: '#262626' },
      });
    });

    it('show_page_number=false disables the stamp document-wide', () => {
      expect(stampOf(customPage({ show_page_number: false })).stampNumber).toBe(false);
    });

    it('uses the document style and picks white text on a dark chip', () => {
      const page = customPage({ stamp_config: { style: { background: '#123', opacity: '0.5' } } });
      expect(stampOf(page).stampStyle).toEqual({ background: '#123', opacity: 0.5, textColor: '#ffffff' });
    });

    it('per-page overrides beat the document style and are keyed by absolute index', () => {
      const page = customPage({
        page_count: 2,
        page_from: 4,
        show_page_number: false,
        stamp_config: {
          style: { background: '#000000', opacity: 0.3 },
          pages: {
            4: { enabled: true, background: '#ffeeaa', opacity: 1 },
            5: { enabled: false },
          },
        },
      });
      const { items } = computeSequence({ agenda, months: [], customPages: [page] });
      expect(items[0]).toMatchObject({ stampNumber: true, stampStyle: { background: '#ffeeaa', opacity: 1, textColor: '#262626' } });
      // enabled:false override, no style override → falls back to document style
      expect(items[1]).toMatchObject({ stampNumber: false, stampStyle: { background: '#000000', opacity: 0.3, textColor: '#ffffff' } });
    });

    it('an override with only enabled set inherits built-in style', () => {
      const page = customPage({ stamp_config: { pages: { 0: { enabled: true } } } });
      expect(stampOf(page).stampStyle).toEqual({ background: '#ffffff', opacity: 0.82, textColor: '#262626' });
    });
  });

  it('matches the calendar helper for the month sequence', () => {
    const { items } = computeSequence({ agenda, months: [], customPages: [] });
    const overviews = items.filter((i) => i.kind === 'monthOverview').map(({ year, month }) => ({ year, month }));
    expect(overviews).toEqual(academicMonthSequence('2026-2027', 9, 10));
  });
});

describe('eventsForMonth', () => {
  const events = [
    { title: 'PD Day', start_date: new Date('2026-09-14T00:00:00Z'), end_date: null, is_school_closed: true },
    { title: 'Spirit Week', start_date: '2026-09-28', end_date: '2026-10-02', is_school_closed: false },
    { title: 'Winter Break', start_date: '2026-12-21', end_date: '2027-01-03', is_school_closed: true },
  ];

  it('keeps events overlapping the month and normalizes dates to YYYY-MM-DD', () => {
    expect(eventsForMonth(events, 2026, 9)).toEqual([
      { title: 'PD Day', startDate: '2026-09-14', endDate: null, isSchoolClosed: true },
      { title: 'Spirit Week', startDate: '2026-09-28', endDate: '2026-10-02', isSchoolClosed: false },
    ]);
  });

  it('includes multi-month events in every month they touch', () => {
    expect(eventsForMonth(events, 2026, 10).map((e) => e.title)).toEqual(['Spirit Week']);
    expect(eventsForMonth(events, 2027, 1).map((e) => e.title)).toEqual(['Winter Break']);
    expect(eventsForMonth(events, 2026, 11)).toEqual([]);
  });

  it('accepts Date objects and timestamps alike', () => {
    const mixed = [{ title: 'X', start_date: new Date('2026-09-01T12:00:00Z'), end_date: '2026-09-01T00:00:00.000Z', is_school_closed: false }];
    expect(eventsForMonth(mixed, 2026, 9)[0]).toMatchObject({ startDate: '2026-09-01', endDate: '2026-09-01' });
  });
});
