// Integration: schedule PDF export — real Puppeteer render, page count
// asserted with pdf-lib (one page per class group / per teacher).

const { PDFDocument } = require('pdf-lib');
const { authenticatedRequest } = require('../setup/integrationApp');

jest.setTimeout(60000);

const asAdmin = (method, url) => authenticatedRequest(method, url);

// Two class groups, two teachers, saves a draft; returns scheduleId.
async function setupTwoGroupDraft() {
  const t1 = await asAdmin('post', '/api/schedule-planner/teachers').send({ displayName: 'Ms. X' });
  const t2 = await asAdmin('post', '/api/schedule-planner/teachers').send({ displayName: 'Mr. Y' });
  const g1 = await asAdmin('post', '/api/schedule-planner/class-groups').send({ name: 'Grade 1' });
  const g2 = await asAdmin('post', '/api/schedule-planner/class-groups').send({ name: 'Grade 2' });
  await asAdmin('post', `/api/schedule-planner/class-groups/${g1.body.data.classGroupId}/courses`).send({
    name: 'Math', sessionsPerWeek: 2, maxPerDay: 1, assignedTeacherId: t1.body.data.plannerTeacherId,
  });
  await asAdmin('post', `/api/schedule-planner/class-groups/${g2.body.data.classGroupId}/courses`).send({
    name: 'English', sessionsPerWeek: 2, maxPerDay: 1, assignedTeacherId: t2.body.data.plannerTeacherId,
  });
  await asAdmin('put', '/api/schedule-planner/day-templates').send({
    days: [
      { dayOfWeek: 1, fillableRanges: [{ startMin: 480, endMin: 600 }] },
      { dayOfWeek: 2, fillableRanges: [{ startMin: 480, endMin: 600 }] },
    ],
  });
  const gen = await asAdmin('post', '/api/schedule-planner/generate').send({
    numCandidates: 1, seed: 11, timeBudgetMs: 2000,
  });
  const save = await asAdmin('post', '/api/schedule-planner/schedules').send({
    name: 'PDF Test Schedule',
    sessions: gen.body.data.candidates[0].sessions,
  });
  return save.body.data.scheduleId;
}

describe('Integration: GET /api/schedule-planner/schedules/:id/pdf', () => {
  it('renders one page per class group for the whole school', async () => {
    const scheduleId = await setupTwoGroupDraft();
    const res = await asAdmin('get', `/api/schedule-planner/schedules/${scheduleId}/pdf`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const doc = await PDFDocument.load(res.body);
    expect(doc.getPageCount()).toBe(2); // Grade 1 + Grade 2
  });

  it('renders per-teacher pages with ?view=teacher', async () => {
    const scheduleId = await setupTwoGroupDraft();
    const res = await asAdmin('get', `/api/schedule-planner/schedules/${scheduleId}/pdf?view=teacher`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const doc = await PDFDocument.load(res.body);
    expect(doc.getPageCount()).toBe(2); // Ms. X + Mr. Y
  });

  it('renders one page per day with ?view=day', async () => {
    // Single class group whose two sessions land on different days:
    // class view = 1 page, day view = 2 pages (Mon, Tue).
    const t1 = await asAdmin('post', '/api/schedule-planner/teachers').send({ displayName: 'Ms. Z' });
    const g1 = await asAdmin('post', '/api/schedule-planner/class-groups').send({ name: 'Grade 3' });
    await asAdmin('post', `/api/schedule-planner/class-groups/${g1.body.data.classGroupId}/courses`).send({
      name: 'Math', sessionsPerWeek: 2, maxPerDay: 1, assignedTeacherId: t1.body.data.plannerTeacherId,
    });
    await asAdmin('put', '/api/schedule-planner/day-templates').send({
      days: [
        { dayOfWeek: 1, fillableRanges: [{ startMin: 480, endMin: 600 }] },
        { dayOfWeek: 2, fillableRanges: [{ startMin: 480, endMin: 600 }] },
      ],
    });
    const gen = await asAdmin('post', '/api/schedule-planner/generate').send({
      numCandidates: 1, seed: 12, timeBudgetMs: 2000,
    });
    const save = await asAdmin('post', '/api/schedule-planner/schedules').send({
      name: 'Day View PDF', sessions: gen.body.data.candidates[0].sessions,
    });

    const res = await asAdmin('get', `/api/schedule-planner/schedules/${save.body.data.scheduleId}/pdf?view=day`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const doc = await PDFDocument.load(res.body);
    expect(doc.getPageCount()).toBe(2); // Monday + Tuesday
  });

  it('renders a single class page with ?classGroupId=', async () => {
    const scheduleId = await setupTwoGroupDraft();
    const list = await asAdmin('get', '/api/schedule-planner/config');
    const gid = list.body.data.classGroups.find((g) => g.name === 'Grade 1').classGroupId;
    const res = await asAdmin('get', `/api/schedule-planner/schedules/${scheduleId}/pdf?classGroupId=${gid}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const doc = await PDFDocument.load(res.body);
    expect(doc.getPageCount()).toBe(1); // Grade 1 only
  });

  it('renders a single teacher page with ?view=teacher&teacherId=', async () => {
    const scheduleId = await setupTwoGroupDraft();
    const list = await asAdmin('get', '/api/schedule-planner/config');
    const tid = list.body.data.teachers.find((t) => t.displayName === 'Ms. X').plannerTeacherId;
    const res = await asAdmin('get', `/api/schedule-planner/schedules/${scheduleId}/pdf?view=teacher&teacherId=${tid}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const doc = await PDFDocument.load(res.body);
    expect(doc.getPageCount()).toBe(1); // Ms. X only
  });

  it('404s for a teacherId not in the schedule', async () => {
    const scheduleId = await setupTwoGroupDraft();
    const res = await asAdmin(
      'get',
      `/api/schedule-planner/schedules/${scheduleId}/pdf?view=teacher&teacherId=00000000-0000-0000-0000-000000000000`
    );
    expect(res.status).toBe(404);
  });

  it('404s for an unknown schedule', async () => {
    const res = await asAdmin(
      'get',
      '/api/schedule-planner/schedules/00000000-0000-0000-0000-000000000000/pdf'
    );
    expect(res.status).toBe(404);
  });
});

// ─── PNG / Word formats ───────────────────────────────────────────────────

const JSZip = require('jszip');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const getBinary = (url) =>
  asAdmin('get', url)
    .buffer(true)
    .parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

describe('Integration: schedule export formats', () => {
  it('downloads a single class as one PNG', async () => {
    const scheduleId = await setupTwoGroupDraft();
    const groups = await asAdmin('get', '/api/schedule-planner/class-groups');
    const res = await getBinary(
      `/api/schedule-planner/schedules/${scheduleId}/pdf?format=png&classGroupId=${groups.body.data[0].classGroupId}`
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename=".+\.png"$/);
    expect(res.body.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('bundles one PNG per page into a zip for the whole school', async () => {
    const scheduleId = await setupTwoGroupDraft();
    const res = await getBinary(`/api/schedule-planner/schedules/${scheduleId}/pdf?format=png`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const zip = await JSZip.loadAsync(res.body);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(['01_Grade_1.png', '02_Grade_2.png']);
    const first = await zip.file(names[0]).async('nodebuffer');
    expect(first.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });

  it('downloads an editable Word document with a table per page', async () => {
    const scheduleId = await setupTwoGroupDraft();
    const res = await getBinary(`/api/schedule-planner/schedules/${scheduleId}/pdf?format=docx&view=teacher`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    const docx = await JSZip.loadAsync(res.body);
    const xml = await docx.file('word/document.xml').async('string');
    expect(xml).toContain('Ms. X');
    expect(xml).toContain('Mr. Y');
    expect(xml).toContain('Math');
    expect((xml.match(/<w:tbl>/g) || []).length).toBe(2);
  });

  it('rejects an unknown format', async () => {
    const scheduleId = await setupTwoGroupDraft();
    const res = await asAdmin('get', `/api/schedule-planner/schedules/${scheduleId}/pdf?format=gif`);
    expect(res.status).toBe(400);
  });
});
