// Integration: School Calendar + Agenda routes, including a REAL
// end-to-end assembly (actual Puppeteer render + pdf-lib merge) with
// storage mocked to round-trip uploaded buffers.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({
    emails: { send: jest.fn().mockResolvedValue({}) },
  })),
}));
// NOTE: puppeteer is deliberately NOT mocked — the generate test runs the
// real render pipeline to verify page-count determinism end to end.

const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const { authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../__mocks__/config/supabaseClient');

const SCHOOL = 'ALHAADIACADEMY';

/** Build a real N-page Letter PDF buffer for upload tests. */
async function buildTestPdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Test custom page ${i + 1}`, { x: 50, y: 700, size: 24 });
  }
  return Buffer.from(await doc.save());
}

const createAgenda = () =>
  authenticatedRequest('post', '/api/agendas')
    .send({ school: SCHOOL, academicYear: '2025-2026', footerText: 'Al Haadi Academy | www.alhaadiacademy.ca' });

describe('Integration: School Calendar Routes', () => {
  beforeEach(() => supabase._reset());

  it('creates, lists (by academic year), updates and deletes events', async () => {
    const createRes = await authenticatedRequest('post', '/api/calendar-events')
      .send({
        school: SCHOOL,
        title: 'PA Day',
        category: 'pa-day',
        startDate: '2025-09-19',
        isSchoolClosed: true,
      });
    expect(createRes.status).toBe(201);
    const eventId = createRes.body.data.eventId;
    expect(createRes.body.data.isSchoolClosed).toBe(true);

    // Range event
    await authenticatedRequest('post', '/api/calendar-events').send({
      school: SCHOOL,
      title: 'Winter Break',
      category: 'holiday',
      startDate: '2025-12-22',
      endDate: '2026-01-02',
      isSchoolClosed: true,
    });

    const listRes = await authenticatedRequest('get', `/api/calendar-events?school=${SCHOOL}&academicYear=2025-2026`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data).toHaveLength(2);

    // Outside the academic year window
    const emptyRes = await authenticatedRequest('get', `/api/calendar-events?school=${SCHOOL}&academicYear=2027-2028`);
    expect(emptyRes.body.data).toHaveLength(0);

    const patchRes = await authenticatedRequest('patch', `/api/calendar-events/${eventId}`)
      .send({ title: 'PD Day' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.title).toBe('PD Day');
    expect(patchRes.body.data.isSchoolClosed).toBe(true); // unchanged

    const deleteRes = await authenticatedRequest('delete', `/api/calendar-events/${eventId}`);
    expect(deleteRes.status).toBe(200);
  });

  it('rejects events without required fields', async () => {
    const res = await authenticatedRequest('post', '/api/calendar-events')
      .send({ school: SCHOOL, title: 'No date' });
    expect(res.status).toBe(400);
  });
});

describe('Integration: Agenda Routes', () => {
  let pool;

  beforeAll(() => {
    pool = getTestPool();
  });

  beforeEach(() => supabase._reset());

  it('creates an agenda and seeds ten month configs', async () => {
    const res = await createAgenda();
    expect(res.status).toBe(201);
    expect(res.body.data.academicYear).toBe('2025-2026');
    expect(res.body.data.status).toBe('draft');

    const detail = await authenticatedRequest('get', `/api/agendas/${res.body.data.agendaId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.months).toHaveLength(10);
    expect(detail.body.data.months.map((m) => m.month).sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4, 5, 6, 9, 10, 11, 12]);
    expect(detail.body.data.customPages).toHaveLength(0);
  });

  it('rejects a duplicate academic year for the same school', async () => {
    await createAgenda();
    const dup = await createAgenda();
    expect(dup.status).toBe(409);
  });

  it('rejects malformed academic years', async () => {
    const res = await authenticatedRequest('post', '/api/agendas')
      .send({ school: SCHOOL, academicYear: '2025-2027' });
    expect(res.status).toBe(400);
  });

  it('uploads a multi-page PDF, detects page count, and reflects it in the manifest', async () => {
    const { body: { data: agenda } } = await createAgenda();
    const pdfBuffer = await buildTestPdf(3);

    const uploadRes = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/pages`)
      .field('anchor', 'intro')
      .field('title', 'Welcome Pack')
      .attach('file', pdfBuffer, { filename: 'welcome.pdf', contentType: 'application/pdf' });

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.data.pageCount).toBe(3);
    expect(uploadRes.body.data.fileType).toBe('pdf');
    expect(supabase._mockStorage.upload).toHaveBeenCalled();

    const manifestRes = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}/manifest`);
    expect(manifestRes.status).toBe(200);
    const { totalPages, items } = manifestRes.body.data;

    // 2025-2026 generated pages: 10 overviews + 48 weekly + 48 notes + 10 evaluations = 116
    expect(totalPages).toBe(116 + 3);
    // Intro PDF expands to 3 custom items at the front
    expect(items.slice(0, 3).every((i) => i.kind === 'custom')).toBe(true);
    expect(items[0].sourcePageIndex).toBe(0);
    expect(items[2].sourcePageIndex).toBe(2);
    expect(items[3].kind).toBe('monthOverview');
    expect(items[3].month).toBe(9);
    expect(items[3].pageNumber).toBe(4);
    // Page numbers are the 1-based global sequence
    expect(items.every((item, index) => item.seq === index + 1)).toBe(true);
  });

  it('rejects corrupt PDFs with a clear message', async () => {
    const { body: { data: agenda } } = await createAgenda();
    const res = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/pages`)
      .field('anchor', 'intro')
      .attach('file', Buffer.from('not a real pdf'), { filename: 'bad.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/could not be read/i);
  });

  it('reorders and moves custom pages between slots', async () => {
    const { body: { data: agenda } } = await createAgenda();
    const pdf = await buildTestPdf(1);

    const first = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/pages`)
      .field('anchor', 'intro').field('title', 'A')
      .attach('file', pdf, { filename: 'a.pdf', contentType: 'application/pdf' });
    const second = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/pages`)
      .field('anchor', 'intro').field('title', 'B')
      .attach('file', pdf, { filename: 'b.pdf', contentType: 'application/pdf' });

    // Swap order and move B to September
    const reorder = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/reorder`)
      .send([
        { pageId: second.body.data.pageId, anchor: 'month', anchorMonth: 9, sortOrder: 0 },
        { pageId: first.body.data.pageId, anchor: 'intro', anchorMonth: null, sortOrder: 0 },
      ]);
    expect(reorder.status).toBe(200);

    const manifest = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}/manifest`);
    const items = manifest.body.data.items;
    expect(items[0].title).toBe('A');
    expect(items[0].anchor).toBe('intro');
    expect(items[1].title).toBe('B');
    expect(items[1].anchorMonth).toBe(9);
    expect(items[2].kind).toBe('monthOverview');
  });

  it('updates month quotes and renders them into weekly pages', async () => {
    const { body: { data: agenda } } = await createAgenda();

    const quoteRes = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/months/9`)
      .send({ quotes: ['Knowledge is light. —TEST QUOTE'] });
    expect(quoteRes.status).toBe(200);

    // Add a school-closed event to check the weekly banner too
    await authenticatedRequest('post', '/api/calendar-events').send({
      school: SCHOOL,
      title: 'PA Day',
      category: 'pa-day',
      startDate: '2025-09-19',
      isSchoolClosed: true,
    });

    const renderRes = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}/render/month/9`);
    expect(renderRes.status).toBe(200);
    // Sept 2025: 1 overview + 5 weekly + 5 notes + 1 evaluation = 12 pages
    expect(renderRes.body.data).toHaveLength(12);

    const weeklyPages = renderRes.body.data.filter((p) => p.kind === 'weekly');
    expect(weeklyPages).toHaveLength(5);
    expect(weeklyPages[0].html).toContain('Knowledge is light');
    // Sept 19 2025 is a Friday in week 3
    expect(weeklyPages[2].html).toContain('PA Day');

    const overview = renderRes.body.data.find((p) => p.kind === 'monthOverview');
    expect(overview.html).toContain('September');
    expect(overview.html).toContain('Days to Remember');
  });

  it('renames a custom page after creation', async () => {
    const { body: { data: agenda } } = await createAgenda();
    const pdf = await buildTestPdf(1);
    const upload = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/pages`)
      .field('anchor', 'intro')
      .attach('file', pdf, { filename: 'WhatsApp Image 2026-07-07.pdf', contentType: 'application/pdf' });
    expect(upload.body.data.title).toBe('WhatsApp Image 2026-07-07');

    const rename = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({ title: 'Welcome Letter' });
    expect(rename.status).toBe(200);
    expect(rename.body.data.title).toBe('Welcome Letter');

    // Empty titles are rejected
    const bad = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({ title: '   ' });
    expect(bad.status).toBe(400);

    // The rename sticks and shows up in the manifest
    const manifest = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}/manifest`);
    expect(manifest.body.data.items[0].title).toBe('Welcome Letter');
  });

  it('toggles an image page between contain and cover fit modes', async () => {
    const { body: { data: agenda } } = await createAgenda();
    // 1x1 PNG (valid minimal image)
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    const upload = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/pages`)
      .field('anchor', 'intro')
      .field('title', 'Poster')
      .attach('file', png, { filename: 'poster.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    expect(upload.body.data.fitMode).toBe('contain'); // safe default: never crop

    const toCover = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({ fitMode: 'cover' });
    expect(toCover.status).toBe(200);
    expect(toCover.body.data.fitMode).toBe('cover');
    expect(toCover.body.data.title).toBe('Poster'); // untouched

    const manifest = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}/manifest`);
    expect(manifest.body.data.items[0].fitMode).toBe('cover');

    const bad = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({ fitMode: 'stretch' });
    expect(bad.status).toBe(400);
  });

  it('saves manual placement (zoom + offsets) and resets it on a preset click', async () => {
    const { body: { data: agenda } } = await createAgenda();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    const upload = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/pages`)
      .field('anchor', 'intro')
      .attach('file', png, { filename: 'art.png', contentType: 'image/png' });
    expect(upload.body.data.zoom).toBe(1);
    expect(upload.body.data.offsetX).toBe(0);

    // Manual placement
    const adjust = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({ fitMode: 'contain', zoom: 1.35, offsetX: -0.05, offsetY: 0.12 });
    expect(adjust.status).toBe(200);
    expect(adjust.body.data.zoom).toBe(1.35);
    expect(adjust.body.data.offsetX).toBe(-0.05);
    expect(adjust.body.data.offsetY).toBe(0.12);

    // Placement flows into the manifest (used by preview AND assembler)
    const manifest = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}/manifest`);
    expect(manifest.body.data.items[0]).toMatchObject({ zoom: 1.35, offsetX: -0.05, offsetY: 0.12 });

    // Out-of-range values rejected
    const badZoom = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({ zoom: 9 });
    expect(badZoom.status).toBe(400);

    // Non-uniform stretch (side-handle resize): zoomY differs from zoom
    const stretch = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({ zoom: 1.0, zoomY: 1.4 });
    expect(stretch.status).toBe(200);
    expect(stretch.body.data.zoom).toBe(1);
    expect(stretch.body.data.zoomY).toBe(1.4);

    const stretchedManifest = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}/manifest`);
    expect(stretchedManifest.body.data.items[0].zoomY).toBe(1.4);

    const badZoomY = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({ zoomY: 7 });
    expect(badZoomY.status).toBe(400);

    // A bare preset click clears manual placement (including the stretch)
    const preset = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({ fitMode: 'cover' });
    expect(preset.body.data).toMatchObject({ fitMode: 'cover', zoom: 1, zoomY: null, offsetX: 0, offsetY: 0 });
  });

  it('toggles page-number stamping per uploaded page (default on)', async () => {
    const { body: { data: agenda } } = await createAgenda();
    const pdf = await buildTestPdf(2);
    const upload = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/pages`)
      .field('anchor', 'intro').field('title', 'Cover Pack')
      .attach('file', pdf, { filename: 'cover.pdf', contentType: 'application/pdf' });
    expect(upload.body.data.showPageNumber).toBe(true);

    // Manifest marks custom items for stamping
    let manifest = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}/manifest`);
    expect(manifest.body.data.items[0].stampNumber).toBe(true);
    expect(manifest.body.data.items[1].stampNumber).toBe(true);

    // Turn it off (e.g. for a cover page)
    const toggled = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({ showPageNumber: false });
    expect(toggled.status).toBe(200);
    expect(toggled.body.data.showPageNumber).toBe(false);

    manifest = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}/manifest`);
    expect(manifest.body.data.items[0].stampNumber).toBe(false);

    // Toggling doesn't clobber placement or title
    expect(toggled.body.data.title).toBe('Cover Pack');
    expect(toggled.body.data.zoom).toBe(1);

    const bad = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({ showPageNumber: 'yes' });
    expect(bad.status).toBe(400);
  });

  it('supports per-source-page number overrides and chip styling', async () => {
    const { body: { data: agenda } } = await createAgenda();
    const pdf = await buildTestPdf(3);
    const upload = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/pages`)
      .field('anchor', 'intro').field('title', 'Booklet')
      .attach('file', pdf, { filename: 'booklet.pdf', contentType: 'application/pdf' });

    // Disable page 1 only; style page 3 as a dark navy chip at 60%
    const patch = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({
        stampConfig: {
          style: { background: '#ffffff', opacity: 0.9 },
          pages: {
            '0': { enabled: false },
            '2': { background: '#1a2a55', opacity: 0.6 },
          },
        },
      });
    expect(patch.status).toBe(200);

    const manifest = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}/manifest`);
    const [p1, p2, p3] = manifest.body.data.items;
    // Page 1: disabled by override
    expect(p1.stampNumber).toBe(false);
    // Page 2: document default style
    expect(p2.stampNumber).toBe(true);
    expect(p2.stampStyle).toMatchObject({ background: '#ffffff', opacity: 0.9, textColor: '#262626' });
    // Page 3: dark chip -> auto white text
    expect(p3.stampNumber).toBe(true);
    expect(p3.stampStyle).toMatchObject({ background: '#1a2a55', opacity: 0.6, textColor: '#ffffff' });

    // Invalid configs rejected
    const badColor = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({ stampConfig: { style: { background: 'navy' } } });
    expect(badColor.status).toBe(400);
    const badOpacity = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({ stampConfig: { pages: { '1': { opacity: 3 } } } });
    expect(badOpacity.status).toBe(400);
    const badKey = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`)
      .send({ stampConfig: { pages: { abc: { enabled: false } } } });
    expect(badKey.status).toBe(400);

    // Config survives clone-forward
    const clone = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/clone`)
      .send({ academicYear: '2026-2027' });
    const cloneDetail = await authenticatedRequest('get', `/api/agendas/${clone.body.data.agendaId}`);
    expect(cloneDetail.body.data.customPages[0].stampConfig.pages['0']).toEqual({ enabled: false });
  });

  it('themes the generated pages via a background color', async () => {
    const { body: { data: agenda } } = await createAgenda();
    expect(agenda.theme).toEqual({});

    const themed = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}`)
      .send({ theme: { background: '#f5ecd9' } });
    expect(themed.status).toBe(200);
    expect(themed.body.data.theme).toEqual({ background: '#f5ecd9' });

    // Rendered pages carry the background + derived shading variables
    const render = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}/render/month/9`);
    expect(render.body.data[0].html).toContain('--page-bg: #f5ecd9');
    expect(render.body.data[0].html).toContain('--shade: #dfd7c5'); // auto-derived

    // Manifest exposes resolved colors for the preview
    const manifest = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}/manifest`);
    expect(manifest.body.data.theme).toMatchObject({ background: '#f5ecd9' });

    // Invalid colors rejected
    const bad = await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}`)
      .send({ theme: { background: 'beige' } });
    expect(bad.status).toBe(400);

    // Theme carries over on clone
    const clone = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/clone`)
      .send({ academicYear: '2026-2027' });
    const cloneDetail = await authenticatedRequest('get', `/api/agendas/${clone.body.data.agendaId}`);
    expect(cloneDetail.body.data.theme).toEqual({ background: '#f5ecd9' });
  });

  it('deletes a custom page and its storage object', async () => {
    const { body: { data: agenda } } = await createAgenda();
    const pdf = await buildTestPdf(1);
    const upload = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/pages`)
      .field('anchor', 'closing')
      .attach('file', pdf, { filename: 'x.pdf', contentType: 'application/pdf' });

    const del = await authenticatedRequest('delete', `/api/agendas/${agenda.agendaId}/pages/${upload.body.data.pageId}`);
    expect(del.status).toBe(200);
    expect(supabase._mockStorage.remove).toHaveBeenCalled();

    const detail = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}`);
    expect(detail.body.data.customPages).toHaveLength(0);
  });

  it('clones an agenda forward: settings, quotes and custom pages carry over', async () => {
    const { body: { data: agenda } } = await createAgenda();
    await authenticatedRequest('patch', `/api/agendas/${agenda.agendaId}/months/9`)
      .send({ quotes: ['Carry me forward'] });
    const pdf = await buildTestPdf(2);
    await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/pages`)
      .field('anchor', 'intro').field('title', 'Welcome')
      .attach('file', pdf, { filename: 'w.pdf', contentType: 'application/pdf' });

    const cloneRes = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/clone`)
      .send({ academicYear: '2026-2027' });
    expect(cloneRes.status).toBe(201);
    expect(cloneRes.body.data.academicYear).toBe('2026-2027');
    expect(cloneRes.body.data.calendarEventCount).toBe(0);
    expect(supabase._mockStorage.copy).toHaveBeenCalled();

    const detail = await authenticatedRequest('get', `/api/agendas/${cloneRes.body.data.agendaId}`);
    expect(detail.body.data.customPages).toHaveLength(1);
    expect(detail.body.data.customPages[0].pageCount).toBe(2);
    expect(detail.body.data.months.find((m) => m.month === 9).quotes).toEqual(['Carry me forward']);

    // September 2026 starts on a Tuesday — the clone's manifest regenerates dates
    const manifest = await authenticatedRequest('get', `/api/agendas/${cloneRes.body.data.agendaId}/manifest`);
    const septWeeklies = manifest.body.data.items.filter((i) => i.kind === 'weekly' && i.month === 9);
    expect(septWeeklies[0].mondayIso).toBe('2026-08-31');
  });

  it('generates the full print-ready PDF end to end (real Puppeteer + pdf-lib)', async () => {
    const { body: { data: agenda } } = await createAgenda();

    // Round-trip storage: remember uploads, serve them back on download
    const stored = new Map();
    supabase._mockStorage.upload.mockImplementation(async (path, buffer) => {
      stored.set(path, Buffer.from(buffer));
      return { data: { path }, error: null };
    });
    supabase._mockStorage.download.mockImplementation(async (path) => {
      const buffer = stored.get(path);
      if (!buffer) return { data: null, error: { message: `not stored: ${path}` } };
      return { data: { arrayBuffer: async () => buffer }, error: null };
    });

    // Two intro pages (PDF) + one image page (embedded losslessly)
    // + calendar events for the overview
    const pdf = await buildTestPdf(2);
    await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/pages`)
      .field('anchor', 'intro').field('title', 'Welcome')
      .attach('file', pdf, { filename: 'welcome.pdf', contentType: 'application/pdf' });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/pages`)
      .field('anchor', 'closing').field('title', 'Poster')
      .attach('file', png, { filename: 'poster.png', contentType: 'image/png' });
    await authenticatedRequest('post', '/api/calendar-events').send({
      school: SCHOOL,
      title: 'First Day of School',
      startDate: '2025-09-02',
    });

    const generateRes = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/generate`);
    expect(generateRes.status).toBe(202);
    expect(generateRes.body.data.status).toBe('generating');

    // Concurrent generate is rejected while running
    const concurrent = await authenticatedRequest('post', `/api/agendas/${agenda.agendaId}/generate`);
    expect(concurrent.status).toBe(409);

    // Poll until the background assembly finishes
    let status = 'generating';
    let row;
    const deadline = Date.now() + 90000;
    while (status === 'generating' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      ({ rows: [row] } = await pool.query(
        'SELECT status, generated_file_path, generated_page_count, generation_error FROM agendas WHERE agenda_id = $1',
        [agenda.agendaId]
      ));
      status = row.status;
    }

    expect(row.generation_error).toBeNull();
    expect(status).toBe('generated');
    // 116 generated + 2 custom PDF pages + 1 image page
    expect(row.generated_page_count).toBe(119);

    // The final PDF lands on local disk (NOT Supabase — free plan 50MB cap)
    const finalBuffer = fs.readFileSync(row.generated_file_path);
    const finalPdf = await PDFDocument.load(finalBuffer);
    expect(finalPdf.getPageCount()).toBe(119);

    // Size regression guard: batched copyPages keeps shared resources
    // deduped — a plain 119-page book must stay well under 10MB
    expect(finalBuffer.length).toBeLessThan(10 * 1024 * 1024);

    // Download endpoint streams the PDF with a filename
    const download = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}/download`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(download.headers['content-disposition']).toContain('agenda-2025-2026.pdf');
    expect(download.body.slice(0, 4).toString()).toBe('%PDF');

    // After the file disappears (server restart/redeploy), 410 asks for a regenerate
    fs.unlinkSync(row.generated_file_path);
    const gone = await authenticatedRequest('get', `/api/agendas/${agenda.agendaId}/download`);
    expect(gone.status).toBe(410);
    const { width, height } = finalPdf.getPage(0).getSize();
    expect(Math.round(width)).toBe(612);
    expect(Math.round(height)).toBe(792);
  }, 120000);
});
