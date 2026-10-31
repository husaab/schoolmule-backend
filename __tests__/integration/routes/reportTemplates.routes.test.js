// Report Template Designer on a real Postgres: the migration's objects, the
// /api/report-templates API end to end, and a report printed by the engine
// through the JK route under REPORT_ENGINE=new. Puppeteer is real (publish,
// server previews and the engine print each lay a report out); storage is
// the Supabase mock.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({}) } })),
}));

const fs = require('fs');
const path = require('path');
const { getTestPool } = require('../setup/setupTestDB');
const { authenticatedRequest } = require('../setup/integrationApp');
const supabase = require('../../../config/supabaseClient');
const { reportKit, engineVersion } = require('../../../services/reportEngine/render');

const SCHOOL = 'ALHAADIACADEMY';
const OTHER_SCHOOL = 'PLAYGROUND';
const BASE = '/api/report-templates';
const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '6a1f0c2e-1d3b-4c5a-9e8f-0000000000aa';
const OTHER_ADMIN_ID = '6a1f0c2e-1d3b-4c5a-9e8f-0000000000bb';
const MIGRATION = path.resolve(__dirname, '../../../database/migrations/report_templates_migration.sql');

const kit = reportKit();
// Whichever built-in prints JK progress reports in this bundle: the tests
// follow the bundle rather than a fixed key.
const builtInFor = (docType, grade) => kit.DEFAULT_TEMPLATES.find((t) => t.docType === docType && t.grades.includes(grade)) || null;
const JK_PROGRESS = builtInFor('progress_report', 'JK');
/** What coverage says prints (docType, grade) with no assignment: the bundle's built-in, else legacy. */
const unassigned = (docType, grade) => {
  const def = builtInFor(docType, grade);
  return def ? { source: 'default', defaultKey: def.key, name: def.name } : { source: 'legacy', defaultKey: null };
};

const admin = (method, url) => authenticatedRequest(method, url);
const teacher = (method, url) => authenticatedRequest(method, url, { userId: TEACHER_ID, role: 'TEACHER', email: 'teacher.rt@example.test', username: 'Teacher RT' });
const otherAdmin = (method, url) => authenticatedRequest(method, url, { userId: OTHER_ADMIN_ID, school: OTHER_SCHOOL, email: 'admin.other@example.test' });
const binary = (req) => req.buffer(true).parse((res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

let pool;
let yearId;
let jkStudentId;
let gradeFourStudentId;

beforeAll(() => { pool = getTestPool(); });

beforeEach(async () => {
  supabase._reset();
  yearId = (await pool.query(
    `SELECT school_year_id FROM school_years WHERE school = $1 AND is_active`, [SCHOOL],
  )).rows[0].school_year_id;
  await pool.query(
    `INSERT INTO terms (school, name, start_date, end_date, academic_year, is_active, school_year_id) VALUES
       ($1, 'Term 1', '2025-09-01', '2026-01-31', '2025-2026', true, $2),
       ($1, 'Term 2', '2026-02-01', '2026-06-30', '2025-2026', false, $2)`,
    [SCHOOL, yearId],
  );
  const student = async (name, grade) => (await pool.query(
    `INSERT INTO students (name, school, grade, school_year_id) VALUES ($1, $2, $3, $4) RETURNING student_id`,
    [name, SCHOOL, grade, yearId],
  )).rows[0].student_id;
  jkStudentId = await student('Jay Testchild', 'JK');
  gradeFourStudentId = await student('Quinn Sample', '4');
});

async function createTemplate(name, body = {}) {
  const res = await admin('post', BASE).send({ name, docType: 'progress_report', fromDefault: JK_PROGRESS.key, ...body });
  expect(res.status).toBe(201);
  return res.body;
}

async function saveDraft(templateId, doc, rev) {
  const res = await admin('put', `${BASE}/${templateId}/draft`).send({ doc, rev });
  expect(res.status).toBe(200);
  return res.body.draftRev;
}

async function publish(templateId, note) {
  const res = await admin('post', `${BASE}/${templateId}/publish`).send({ note });
  expect(res.status).toBe(201);
  return res.body;
}

describe('report_templates_migration.sql', () => {
  it('creates the tables, columns and immutability trigger, and re-applies cleanly', async () => {
    const { rows: tables } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('report_templates', 'report_template_versions', 'report_template_assignments', 'report_field_values')
       ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual(['report_field_values', 'report_template_assignments', 'report_template_versions', 'report_templates']);
    for (const table of ['report_cards', 'progress_reports']) {
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1
           AND column_name IN ('template_version_id', 'template_key', 'engine_version', 'render_warnings') ORDER BY column_name`,
        [table],
      );
      expect(rows.map((r) => r.column_name)).toEqual(['engine_version', 'render_warnings', 'template_key', 'template_version_id']);
    }
    const { rows: triggers } = await pool.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'trg_report_template_versions_immutable'`);
    expect(triggers).toHaveLength(1);

    // Idempotent on a schema that already has everything; seeds Al Haadi's T2 row once.
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const { rows: seeded } = await pool.query(
      `SELECT doc_type, default_key, grades, terms, priority FROM report_template_assignments WHERE school = $1`, [SCHOOL],
    );
    expect(seeded).toEqual([{
      doc_type: 'report_card', default_key: 'report-card-t1t2final',
      grades: ['1', '2', '3', '4', '5', '6', '7', '8'], terms: ['Term 2'], priority: 50,
    }]);
  });

  it('refuses an assignment with both or neither target', async () => {
    await expect(pool.query(
      `INSERT INTO report_template_assignments (school, doc_type) VALUES ($1, 'report_card')`, [SCHOOL],
    )).rejects.toMatchObject({ code: '23514' });
  });
});

describe('templates CRUD', () => {
  it('creates, lists, reads, renames and saves drafts with optimistic concurrency', async () => {
    const created = await createTemplate('JK progress (ours)');
    const id = created.template.templateId;
    expect(created.template).toMatchObject({ name: 'JK progress (ours)', docType: 'progress_report', baseKey: JK_PROGRESS.key, draftRev: 1, published: null, hasUnpublishedChanges: true, assignedCount: 0 });
    expect(created.draft).toEqual(kit.defaultTemplate(JK_PROGRESS.key));

    const list = await admin('get', BASE);
    expect(list.status).toBe(200);
    expect(list.body.templates.map((t) => t.templateId)).toEqual([id]);
    expect(list.body.defaults.map((d) => d.key)).toEqual(kit.DEFAULT_TEMPLATES.map((d) => d.key));

    const blank = await admin('post', BASE).send({ name: 'Blank card', docType: 'report_card' });
    expect(blank.status).toBe(201);
    expect(blank.body.draft).toMatchObject({ docType: 'report_card', blocks: [] });

    const dup = await admin('post', BASE).send({ name: 'jk PROGRESS (ours)', docType: 'progress_report' });
    expect(dup.status).toBe(409);
    const renameDup = await admin('patch', `${BASE}/${blank.body.template.templateId}`).send({ name: 'JK Progress (Ours)' });
    expect(renameDup.status).toBe(409);
    const renamed = await admin('patch', `${BASE}/${id}`).send({ name: 'JK progress 2025' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('JK progress 2025');

    const doc = { ...created.draft, theme: { ...created.draft.theme, accent: '#123456' } };
    expect(await saveDraft(id, doc, 1)).toBe(2);
    const stale = await admin('put', `${BASE}/${id}/draft`).send({ doc, rev: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.draftRev).toBe(2);
    const invalid = await admin('put', `${BASE}/${id}/draft`).send({ doc: { ...doc, blocks: 'nope' }, rev: 2 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.errors.length).toBeGreaterThan(0);

    const detail = await admin('get', `${BASE}/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ draftRev: 2, publishedDoc: null });
    expect(detail.body.draft.theme.accent).toBe('#123456');
  });

  it('accepts a draft over the 100 KB default body limit', async () => {
    const created = await createTemplate('Big');
    const image = `data:image/png;base64,${'A'.repeat(400000)}`;
    const doc = {
      ...created.draft,
      header: { ...created.draft.header, elements: [...created.draft.header.elements, { id: 'big-img', type: 'image', x: 0, y: 0, w: 10, h: 10, src: { kind: 'url', url: image } }] },
    };
    expect(await saveDraft(created.template.templateId, doc, 1)).toBe(2);
  });
});

describe('publishing', () => {
  it('lays the draft out, creates immutable numbered versions, and restores / discards', async () => {
    const created = await createTemplate('Published one');
    const id = created.template.templateId;

    const v1 = await publish(id, 'First cut');
    expect(v1).toMatchObject({ versionNo: 1, pageCount: expect.any(Number) });
    expect(v1.pageCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(v1.warnings)).toBe(true);

    const { rows: [stored] } = await pool.query(
      'SELECT version_no, doc, doc_sha256, engine_version, note, published_by FROM report_template_versions WHERE version_id = $1', [v1.versionId],
    );
    expect(stored).toMatchObject({ version_no: 1, engine_version: engineVersion(), note: 'First cut', published_by: ADMIN_ID });
    expect(stored.doc).toEqual(created.draft);
    expect(stored.doc_sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(pool.query(`UPDATE report_template_versions SET doc = '{}'::jsonb WHERE version_id = $1`, [v1.versionId]))
      .rejects.toThrow(/immutable/);

    let detail = (await admin('get', `${BASE}/${id}`)).body;
    expect(detail.template).toMatchObject({ published: { versionId: v1.versionId, versionNo: 1 }, hasUnpublishedChanges: false });
    expect(detail.publishedDoc).toEqual(created.draft);

    const edited = { ...created.draft, theme: { ...created.draft.theme, color: '#222222' } };
    const rev = await saveDraft(id, edited, detail.draftRev);
    detail = (await admin('get', `${BASE}/${id}`)).body;
    expect(detail.template.hasUnpublishedChanges).toBe(true);

    const v2 = await publish(id);
    expect(v2.versionNo).toBe(2);
    const versions = await admin('get', `${BASE}/${id}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.versions.map((v) => [v.versionNo, v.isPublished, v.publishedBy])).toEqual([[2, true, 'Test User'], [1, false, 'Test User']]);

    const restored = await admin('post', `${BASE}/${id}/versions/${v1.versionId}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.draftRev).toBe(rev + 1);
    expect(restored.body.draft).toEqual(created.draft);

    const discarded = await admin('post', `${BASE}/${id}/discard-draft`);
    expect(discarded.status).toBe(200);
    expect(discarded.body.draft).toEqual(edited);
    expect(discarded.body.draftRev).toBe(rev + 2);

    const never = await createTemplate('Never published');
    expect((await admin('post', `${BASE}/${never.template.templateId}/discard-draft`)).status).toBe(400);
  }, 60000);
});

describe('delete rules', () => {
  it('409s while assigned, archives once used by a printed report, hard-deletes otherwise', async () => {
    const used = await createTemplate('Used');
    const usedId = used.template.templateId;
    const v = await publish(usedId);

    const assignment = await admin('post', `${BASE}/assignments`).send({ docType: 'progress_report', templateId: usedId, grades: ['JK'], terms: null, priority: 100 });
    expect(assignment.status).toBe(201);
    const refused = await admin('delete', `${BASE}/${usedId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.assignedCount).toBe(1);
    expect((await admin('delete', `${BASE}/assignments/${assignment.body.assignmentId}`)).body).toEqual({ deleted: true });

    await pool.query(
      `INSERT INTO progress_reports (student_id, term, student_name, grade, file_path, school, template_version_id)
       VALUES ($1, 'Term 1', 'Jay Testchild', 'JK', 'ALHAADIACADEMY/x.pdf', $2, $3)`,
      [jkStudentId, SCHOOL, v.versionId],
    );
    expect((await admin('delete', `${BASE}/${usedId}`)).body).toEqual({ archived: true });
    expect((await admin('get', `${BASE}/${usedId}`)).status).toBe(404);
    expect((await admin('get', BASE)).body.templates).toEqual([]);
    // The name is free again; the version the report points at is kept.
    await createTemplate('Used');
    expect((await pool.query('SELECT 1 FROM report_template_versions WHERE version_id = $1', [v.versionId])).rows).toHaveLength(1);

    const unused = await createTemplate('Unused');
    await publish(unused.template.templateId);
    expect((await admin('delete', `${BASE}/${unused.template.templateId}`)).body).toEqual({ archived: false });
    const left = await pool.query('SELECT 1 FROM report_template_versions WHERE template_id = $1', [unused.template.templateId]);
    expect(left.rows).toHaveLength(0);
  }, 60000);
});

describe('assignments and coverage', () => {
  it('creates, edits, lists and removes assignments; coverage follows them', async () => {
    const created = await createTemplate('Grade 4 T2');
    const id = created.template.templateId;

    // Assignable before it's published, but nothing prints from it until then.
    const a = await admin('post', `${BASE}/assignments`).send({ docType: 'progress_report', templateId: id, grades: ['4', 'JK'], terms: ['term 2'], priority: 20 });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ docType: 'progress_report', templateId: id, defaultKey: null, name: 'Grade 4 T2', grades: ['JK', '4'], terms: ['term 2'], priority: 20, usable: false });

    let cov = await admin('get', `${BASE}/coverage?docType=progress_report`);
    expect(cov.status).toBe(200);
    expect(cov.body.terms).toEqual(['Term 1', 'Term 2']);
    const cell = (grade, term) => cov.body.cells.find((c) => c.grade === grade && c.term === term);
    expect(cell('4', 'Term 2')).toMatchObject(unassigned('progress_report', '4'));
    expect(cell('JK', 'Term 2')).toMatchObject({ source: 'default', defaultKey: JK_PROGRESS.key });

    await publish(id);
    cov = await admin('get', `${BASE}/coverage?docType=progress_report`);
    expect(cell('4', 'Term 2')).toMatchObject({ source: 'assignment', templateId: id, name: 'Grade 4 T2' });
    expect(cell('JK', 'Term 2')).toMatchObject({ source: 'assignment', templateId: id });
    expect(cell('4', 'Term 1')).toMatchObject(unassigned('progress_report', '4'));

    const patched = await admin('patch', `${BASE}/assignments/${a.body.assignmentId}`).send({ terms: null, defaultKey: JK_PROGRESS.key });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ templateId: null, defaultKey: JK_PROGRESS.key, terms: null, grades: ['JK', '4'], usable: true });

    const listed = await admin('get', `${BASE}/assignments?docType=progress_report`);
    expect(listed.body.assignments.map((x) => x.assignmentId)).toEqual([a.body.assignmentId]);
    expect((await admin('get', `${BASE}/assignments?docType=report_card`)).body.assignments).toEqual([]);

    const wrongType = await admin('post', `${BASE}/assignments`).send({ docType: 'report_card', templateId: id, grades: null, terms: null });
    expect(wrongType.status).toBe(400);

    expect((await admin('delete', `${BASE}/assignments/${a.body.assignmentId}`)).body).toEqual({ deleted: true });
    expect((await admin('delete', `${BASE}/assignments/${a.body.assignmentId}`)).status).toBe(404);
  }, 60000);
});

describe('tenancy and permissions', () => {
  it("another school's admin sees none of it", async () => {
    await pool.query(`INSERT INTO schools (school_code, name) VALUES ($1, 'Playground Academy') ON CONFLICT DO NOTHING`, [OTHER_SCHOOL]);
    const created = await createTemplate('Mine');
    const id = created.template.templateId;
    const assignment = await admin('post', `${BASE}/assignments`).send({ docType: 'progress_report', defaultKey: JK_PROGRESS.key, grades: null, terms: null });

    expect((await otherAdmin('get', BASE)).body.templates).toEqual([]);
    expect((await otherAdmin('get', `${BASE}/${id}`)).status).toBe(404);
    expect((await otherAdmin('put', `${BASE}/${id}/draft`).send({ doc: created.draft, rev: 1 })).status).toBe(404);
    expect((await otherAdmin('post', `${BASE}/${id}/publish`).send({})).status).toBe(404);
    expect((await otherAdmin('delete', `${BASE}/${id}`)).status).toBe(404);
    expect((await otherAdmin('get', `${BASE}/${id}/versions`)).status).toBe(404);
    expect((await otherAdmin('delete', `${BASE}/assignments/${assignment.body.assignmentId}`)).status).toBe(404);
    expect((await otherAdmin('post', `${BASE}/assignments`).send({ docType: 'progress_report', templateId: id, grades: null, terms: null })).status).toBe(400);
    expect((await otherAdmin('post', BASE).send({ name: 'Copy', docType: 'progress_report', fromTemplateId: id })).status).toBe(404);
    expect((await otherAdmin('get', `${BASE}/preview/data?studentId=${jkStudentId}&docType=progress_report&term=Term%201`)).status).toBe(404);
    expect((await admin('get', `${BASE}/${id}`)).status).toBe(200);
  });

  it('a teacher without school setup is refused the designer but may fill in fields', async () => {
    const res = await teacher('get', BASE);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    expect((await teacher('post', BASE).send({ name: 'X', docType: 'report_card' })).status).toBe(403);
    const fields = await teacher('get', `${BASE}/field-values?docType=progress_report&term=Term%201&grade=JK`);
    expect(fields.status).toBe(200);
  });
});

describe('extra fields, previews and printing with the engine', () => {
  const PRINCIPAL_NOTE = { key: 'principal_note', label: 'Principal note', type: 'longtext', required: true };
  const HOUSE = { key: 'house', label: 'House', type: 'select', options: ['Cedar', 'Maple'], defaultValue: 'Cedar' };

  /** A JK progress template with two extra fields, published and assigned to JK. */
  async function jkTemplateWithFields() {
    const created = await createTemplate('JK with fields');
    const id = created.template.templateId;
    const doc = {
      ...created.draft,
      fields: [PRINCIPAL_NOTE, HOUSE],
      blocks: [...created.draft.blocks, { id: 'note-block', type: 'text', text: 'Note: {{extra.principal_note}} ({{extra.house}})' }],
    };
    await saveDraft(id, doc, 1);
    const version = await publish(id);
    const a = await admin('post', `${BASE}/assignments`).send({ docType: 'progress_report', templateId: id, grades: ['JK'], terms: null, priority: 10 });
    expect(a.status).toBe(201);
    return { id, version };
  }

  it('field values round trip, only for the printing template’s keys', async () => {
    const { id } = await jkTemplateWithFields();

    const empty = await admin('get', `${BASE}/field-values?docType=progress_report&term=Term%201&grade=JK`);
    expect(empty.status).toBe(200);
    expect(empty.body.template).toMatchObject({ source: 'assignment', name: 'JK with fields', templateId: id });
    expect(empty.body.fields.map((f) => f.key)).toEqual(['principal_note', 'house']);
    expect(empty.body.students).toEqual([{ studentId: jkStudentId, name: 'Jay Testchild', values: {} }]);

    const put = (values) => admin('put', `${BASE}/field-values`).send({ docType: 'progress_report', term: 'Term 1', studentId: jkStudentId, values });
    expect((await put({ principal_note: 'A great start.', house: 'Maple' })).body).toEqual({ values: { principal_note: 'A great start.', house: 'Maple' } });
    expect((await put({ house: null })).body).toEqual({ values: { principal_note: 'A great start.' } });
    const badOption = await put({ house: 'Oak' });
    expect(badOption.status).toBe(400);
    const unknown = await put({ shoe_size: '5' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.unknown).toEqual(['shoe_size']);
    // Grade 4 isn't assigned this template: whatever prints it (a built-in,
    // or nothing) has no principal_note field.
    const otherGrade = await admin('put', `${BASE}/field-values`).send({ docType: 'progress_report', term: 'Term 1', studentId: gradeFourStudentId, values: { principal_note: 'x' } });
    expect(otherGrade.status).toBe(400);
    expect(otherGrade.body.unknown).toEqual(['principal_note']);

    const listed = await admin('get', `${BASE}/field-values?docType=progress_report&term=Term%201&grade=JK`);
    expect(listed.body.students[0].values).toEqual({ principal_note: 'A great start.' });
  }, 60000);

  it('preview data, sample and server PDFs', async () => {
    await pool.query(`UPDATE schools SET address = '1 Sample Road', phone = '555-0100' WHERE school_code = $1`, [SCHOOL]);
    await pool.query(
      `INSERT INTO report_field_values (school, student_id, doc_type, term, field_key, value) VALUES ($1, $2, 'progress_report', 'Term 1', 'principal_note', 'Stored note')`,
      [SCHOOL, jkStudentId],
    );

    const data = await admin('get', `${BASE}/preview/data?studentId=${jkStudentId}&docType=progress_report`);
    expect(data.status).toBe(200);
    expect(data.body).toMatchObject({
      dataVersion: 1,
      meta: { docType: 'progress_report', term: 'Term 1' },
      student: { id: jkStudentId, name: 'Jay Testchild', grade: 'JK' },
      school: { code: SCHOOL, name: 'Al Haadi Academy', address: '1 Sample Road' },
      extra: { principal_note: 'Stored note' },
    });
    const skipped = await admin('get', `${BASE}/preview/data?studentId=${gradeFourStudentId}&docType=progress_report&term=Term%201`);
    expect(skipped.status).toBe(422); // no classes in the term

    const students = await admin('get', `${BASE}/preview/students?grade=JK&q=testch`);
    expect(students.body.students).toEqual([{ studentId: jkStudentId, name: 'Jay Testchild', grade: 'JK' }]);

    const sample = await admin('get', `${BASE}/preview/sample?key=JK&docType=progress_report`);
    expect(sample.status).toBe(200);
    expect(sample.body.school).toMatchObject({ code: SCHOOL, name: 'Al Haadi Academy', address: '1 Sample Road', phone: '555-0100', website: '', principal: '', board: '' });
    expect(sample.body.assets).toEqual({ logo: null, principalSignature: null, stamp: null, teacherSignature: null });
    expect((await admin('get', `${BASE}/preview/sample?key=nope&docType=progress_report`)).status).toBe(400);

    const doc = kit.defaultTemplate(JK_PROGRESS.key);
    const forStudent = await binary(admin('post', `${BASE}/preview/pdf`).send({ doc, docType: 'progress_report', studentId: jkStudentId, term: 'Term 1' }));
    expect(forStudent.status).toBe(200);
    expect(forStudent.headers['content-type']).toBe('application/pdf');
    expect(forStudent.body.subarray(0, 4).toString()).toBe('%PDF');
    expect(Number(forStudent.headers['x-report-pages'])).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(JSON.parse(decodeURIComponent(forStudent.headers['x-report-warnings'])))).toBe(true);

    const forSample = await binary(admin('post', `${BASE}/preview/pdf`).send({ doc, docType: 'progress_report', sample: 'worst' }));
    expect(forSample.status).toBe(200);
    expect(forSample.body.subarray(0, 4).toString()).toBe('%PDF');
  }, 60000);

  it('REPORT_ENGINE=new: the JK route prints with the assigned template, same path and row as legacy', async () => {
    const { version } = await jkTemplateWithFields();
    const previous = process.env.REPORT_ENGINE;
    process.env.REPORT_ENGINE = 'new';
    try {
      const generate = () => admin('post', '/api/jk/progress-report/generate').send({ studentId: jkStudentId, term: 'Term 1' });

      const missing = await generate();
      expect(missing.status).toBe(422);
      expect(missing.body.message).toBe('Fill in Principal note for Jay Testchild first');
      expect(supabase._mockStorage.upload).not.toHaveBeenCalled();

      await admin('put', `${BASE}/field-values`).send({ docType: 'progress_report', term: 'Term 1', studentId: jkStudentId, values: { principal_note: 'Settling in well.' } });
      const res = await generate();
      expect(res.status).toBe(200);
      const filePath = 'ALHAADIACADEMY/Jay_Testchild_Term_1_jk_progress_report.pdf';
      expect(res.body.data).toEqual({ studentId: jkStudentId, studentName: 'Jay Testchild', term: 'Term 1', filePath });

      expect(supabase.storage.from).toHaveBeenCalledWith('progress-reports');
      const [uploadedPath, pdf, options] = supabase._mockStorage.upload.mock.calls[0];
      expect(uploadedPath).toBe(filePath);
      expect(Buffer.from(pdf).subarray(0, 4).toString()).toBe('%PDF');
      expect(options).toEqual({ contentType: 'application/pdf', upsert: true });

      const { rows: [row] } = await pool.query('SELECT * FROM progress_reports WHERE student_id = $1 AND term = $2', [jkStudentId, 'Term 1']);
      expect(row).toMatchObject({ file_path: filePath, grade: 'JK', school: SCHOOL, template_version_id: version.versionId, template_key: null, engine_version: engineVersion() });
      expect(Array.isArray(row.render_warnings)).toBe(true);

      // No assignment for JK report cards: the bundle's built-in prints it
      // (the row names the key), or with none the legacy generator does (no
      // provenance). Same file name either way.
      const card = await admin('post', '/api/jk/report-card/generate').send({ studentId: jkStudentId, term: 'Term 1' });
      expect(card.status).toBe(200);
      expect(card.body.data.filePath).toBe('ALHAADIACADEMY/Jay_Testchild_Term_1_jk_report_card.pdf');
      const { rows: [cardRow] } = await pool.query(
        'SELECT template_version_id, template_key, engine_version FROM report_cards WHERE student_id = $1', [jkStudentId],
      );
      const jkCard = builtInFor('report_card', 'JK');
      expect(cardRow).toEqual(jkCard
        ? { template_version_id: null, template_key: jkCard.key, engine_version: engineVersion() }
        : { template_version_id: null, template_key: null, engine_version: null });
    } finally {
      if (previous === undefined) delete process.env.REPORT_ENGINE;
      else process.env.REPORT_ENGINE = previous;
    }
  }, 90000);
});
