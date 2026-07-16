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

  it('404s for an unknown schedule', async () => {
    const res = await asAdmin(
      'get',
      '/api/schedule-planner/schedules/00000000-0000-0000-0000-000000000000/pdf'
    );
    expect(res.status).toBe(404);
  });
});
