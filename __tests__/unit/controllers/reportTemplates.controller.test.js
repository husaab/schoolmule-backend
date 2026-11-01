// Report Template Designer API (/api/report-templates) through the app, with
// the database answered by SQL text and the PDF renderer mocked.

jest.mock('../../../services/reportEngine/render', () => {
  const actual = jest.requireActual('../../../services/reportEngine/render');
  return {
    ...actual,
    renderReportPdf: jest.fn(),
    inlineAssets: jest.fn(async (data) => data),
  };
});

const { authenticatedRequest } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, mockParentUser, TEST_ADMIN_USER_ID } = require('../../helpers/mockAuth');
const { giveRole } = require('../../helpers/mockAccess');
const db = require('../../__mocks__/config/database');
const render = require('../../../services/reportEngine/render');
const q = require('../../../queries/reportTemplates.queries');
const engineQ = require('../../../queries/reportEngineData.queries');
const schoolAssetsQueries = require('../../../queries/schoolAssets.queries');
const { stableStringify, blankDoc } = require('../../../controllers/reportTemplates.controller');

const kit = render.reportKit();
const TEMPLATE_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const VERSION_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const STUDENT_ID = 'cccccccc-3333-4333-8333-333333333333';
const BASE = '/api/report-templates';
const DEFAULT = kit.DEFAULT_TEMPLATES[0];

const validDoc = (docType = DEFAULT.docType) => ({ ...kit.defaultTemplate(DEFAULT.key), docType });
const summaryRow = (fields = {}) => ({
  template_id: TEMPLATE_ID,
  name: 'Our JK report',
  doc_type: DEFAULT.docType,
  base_key: DEFAULT.key,
  draft_rev: 3,
  updated_at: '2026-10-30T12:00:00Z',
  published_version_id: null,
  published_version_no: null,
  published_at: null,
  has_unpublished_changes: true,
  assigned_count: 0,
  ...fields,
});

const activeYear = {
  rows: [{ school_year_id: db.DEFAULT_SCHOOL_YEAR_ID, school: 'ALHAADIACADEMY', label: '2025-2026', is_active: true }],
};

/**
 * Route db.query (and transaction clients) by SQL: `routes` maps a query
 * string to rows, a function of params, or an Error. Unrouted → [].
 */
function routeDb(routes = new Map()) {
  const answer = async (sql, params) => {
    if (typeof sql === 'string' && /^\s*SELECT\s+school_year_id\b/i.test(sql) && sql.includes('FROM school_years')) return activeYear;
    if (routes.has(sql)) {
      const r = routes.get(sql);
      const out = typeof r === 'function' ? r(params) : r;
      if (out instanceof Error) throw out;
      return { rows: out, rowCount: out.length };
    }
    return { rows: [], rowCount: 0 };
  };
  db.query.mockImplementation(answer);
  db._mockClient.query.mockImplementation(answer);
}
const callsTo = (sql) => [...db.query.mock.calls, ...db._mockClient.query.mock.calls].filter(([s]) => s === sql);
const pgError = (code) => Object.assign(new Error(`pg ${code}`), { code });

describe('Report templates API', () => {
  describe('who may use it', () => {
    it('refuses a teacher without school setup', async () => {
      routeDb();
      const res = await authenticatedRequest('get', BASE, mockTeacherUser());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    });

    it('refuses a parent', async () => {
      const res = await authenticatedRequest('get', BASE, mockParentUser());
      expect(res.status).toBe(403);
    });

    it('lets a teacher with report_cards read field values', async () => {
      routeDb();
      const res = await authenticatedRequest('get', `${BASE}/field-values?docType=progress_report&term=Term%201&grade=4`, mockTeacherUser());
      expect(res.status).toBe(200);
      // Whatever the bundle's built-ins print for grade 4; no students seeded.
      expect(res.body).toMatchObject({ fields: expect.any(Array), students: [] });
    });

    it('lets a restricted admin with school_setup design', async () => {
      giveRole(TEST_ADMIN_USER_ID, ['school_setup']);
      routeDb();
      const res = await authenticatedRequest('get', BASE, mockAdminUser());
      expect(res.status).toBe(200);
    });

    it('answers a malformed id as missing', async () => {
      const res = await authenticatedRequest('get', `${BASE}/not-a-uuid`);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Template not found');
    });
  });

  it('lists templates and the built-in defaults, scoped to the caller’s school', async () => {
    routeDb(new Map([[q.listTemplates, [summaryRow({ published_version_id: VERSION_ID, published_version_no: 2, published_at: '2026-10-29T00:00:00Z', has_unpublished_changes: false, assigned_count: 1 })]]]));
    const res = await authenticatedRequest('get', BASE);
    expect(res.status).toBe(200);
    expect(res.body.templates).toEqual([{
      templateId: TEMPLATE_ID, name: 'Our JK report', docType: DEFAULT.docType, baseKey: DEFAULT.key, draftRev: 3,
      updatedAt: '2026-10-30T12:00:00Z', hasUnpublishedChanges: false,
      published: { versionId: VERSION_ID, versionNo: 2, publishedAt: '2026-10-29T00:00:00Z' }, assignedCount: 1,
    }]);
    expect(res.body.defaults.map((d) => d.key)).toEqual(kit.DEFAULT_TEMPLATES.map((d) => d.key));
    expect(res.body.defaults[0]).toEqual({ key: DEFAULT.key, name: DEFAULT.name, description: DEFAULT.description, docType: DEFAULT.docType, grades: DEFAULT.grades });
    expect(callsTo(q.listTemplates)[0][1]).toEqual(['ALHAADIACADEMY']);
  });

  describe('create', () => {
    it.each([
      [{ docType: 'report_card' }, 400, 'needs a name'],
      [{ name: 'x'.repeat(101), docType: 'report_card' }, 400, '100 characters'],
      [{ name: 'Ok', docType: 'memo' }, 400, 'document type'],
      [{ name: 'Ok', docType: 'report_card', fromDefault: 'no-such-default' }, 400, 'Unknown built-in'],
      [{ name: 'Ok', docType: DEFAULT.docType === 'report_card' ? 'progress_report' : 'report_card', fromDefault: DEFAULT.key }, 400, 'That built-in is a'],
      [{ name: 'Ok', docType: 'report_card', fromTemplateId: 'nope' }, 404, 'Template not found'],
    ])('refuses %j', async (body, status, message) => {
      routeDb();
      const res = await authenticatedRequest('post', BASE).send(body);
      expect(res.status).toBe(status);
      expect(res.body.message).toContain(message);
      expect(callsTo(q.insertTemplate)).toHaveLength(0);
    });

    it('copies a built-in, school and author from the token', async () => {
      routeDb(new Map([
        [q.insertTemplate, [{ template_id: TEMPLATE_ID }]],
        [q.selectTemplateDetail, [{ ...summaryRow(), draft_doc: validDoc(), published_doc: null }]],
      ]));
      const res = await authenticatedRequest('post', BASE).send({ name: '  Our JK report ', docType: DEFAULT.docType, fromDefault: DEFAULT.key, school: 'PLAYGROUND' });
      expect(res.status).toBe(201);
      const [[, params]] = callsTo(q.insertTemplate);
      expect(params[0]).toBe('ALHAADIACADEMY');
      expect(params.slice(1, 4)).toEqual([DEFAULT.docType, 'Our JK report', DEFAULT.key]);
      expect(params[4]).toEqual(kit.defaultTemplate(DEFAULT.key));
      expect(params[5]).toBe(TEST_ADMIN_USER_ID);
      expect(res.body).toMatchObject({ template: { templateId: TEMPLATE_ID, published: null }, draftRev: 3, publishedDoc: null });
      expect(res.body.draft.docType).toBe(DEFAULT.docType);
    });

    it('starts a blank template that validates, for either document type', async () => {
      for (const docType of ['report_card', 'progress_report']) {
        const doc = blankDoc(docType);
        expect(doc).toMatchObject({ docType, blocks: [], fields: [], firstHeader: null, firstFooter: null });
        expect(kit.validateTemplate(doc)).toEqual({ ok: true, errors: [] });
      }
    });

    it('copies another template of the school', async () => {
      const source = validDoc();
      routeDb(new Map([
        [q.selectTemplateDraft, (params) => (params[0] === TEMPLATE_ID && params[1] === 'ALHAADIACADEMY' ? [{ template_id: TEMPLATE_ID, doc_type: DEFAULT.docType, draft_doc: source }] : [])],
        [q.insertTemplate, [{ template_id: VERSION_ID }]],
        [q.selectTemplateDetail, [{ ...summaryRow({ template_id: VERSION_ID }), draft_doc: source, published_doc: null }]],
      ]));
      const res = await authenticatedRequest('post', BASE).send({ name: 'Copy', docType: DEFAULT.docType, fromTemplateId: TEMPLATE_ID });
      expect(res.status).toBe(201);
      expect(callsTo(q.insertTemplate)[0][1][4]).toEqual(source);
    });

    it('refuses a duplicate name', async () => {
      routeDb(new Map([[q.insertTemplate, pgError('23505')]]));
      const res = await authenticatedRequest('post', BASE).send({ name: 'Dup', docType: 'report_card' });
      expect(res.status).toBe(409);
      expect(res.body.message).toContain('already exists');
    });
  });

  describe('save draft', () => {
    const draftRow = (rev = 3) => [{ template_id: TEMPLATE_ID, doc_type: DEFAULT.docType, draft_doc: validDoc(), draft_rev: rev }];

    it('saves when the revision matches and returns the new one', async () => {
      routeDb(new Map([[q.selectTemplateDraft, draftRow(3)], [q.updateDraftIfRev, [{ draft_rev: 4 }]]]));
      const res = await authenticatedRequest('put', `${BASE}/${TEMPLATE_ID}/draft`).send({ doc: validDoc(), rev: 3 });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ draftRev: 4 });
      expect(callsTo(q.updateDraftIfRev)[0][1]).toEqual([TEMPLATE_ID, 'ALHAADIACADEMY', validDoc(), TEST_ADMIN_USER_ID, 3]);
    });

    it('409s a stale revision with the current one', async () => {
      routeDb(new Map([[q.selectTemplateDraft, draftRow(5)]]));
      const res = await authenticatedRequest('put', `${BASE}/${TEMPLATE_ID}/draft`).send({ doc: validDoc(), rev: 3 });
      expect(res.status).toBe(409);
      expect(res.body.draftRev).toBe(5);
      expect(callsTo(q.updateDraftIfRev)).toHaveLength(0);
    });

    it('409s when another save lands between the read and the write', async () => {
      let reads = 0;
      routeDb(new Map([[q.selectTemplateDraft, () => { reads += 1; return draftRow(reads === 1 ? 3 : 4); }], [q.updateDraftIfRev, []]]));
      const res = await authenticatedRequest('put', `${BASE}/${TEMPLATE_ID}/draft`).send({ doc: validDoc(), rev: 3 });
      expect(res.status).toBe(409);
      expect(res.body.draftRev).toBe(4);
    });

    it('400s an invalid doc with the engine’s errors, and a doc of the other type', async () => {
      routeDb(new Map([[q.selectTemplateDraft, draftRow(3)]]));
      const bad = await authenticatedRequest('put', `${BASE}/${TEMPLATE_ID}/draft`).send({ doc: { schemaVersion: 1 }, rev: 3 });
      expect(bad.status).toBe(400);
      expect(bad.body.errors.length).toBeGreaterThan(0);
      const other = DEFAULT.docType === 'report_card' ? 'progress_report' : 'report_card';
      const wrongType = await authenticatedRequest('put', `${BASE}/${TEMPLATE_ID}/draft`).send({ doc: validDoc(other), rev: 3 });
      expect(wrongType.status).toBe(400);
      expect(wrongType.body.errors.join(' ')).toContain('the document says');
    });

    it('needs rev', async () => {
      const res = await authenticatedRequest('put', `${BASE}/${TEMPLATE_ID}/draft`).send({ doc: validDoc() });
      expect(res.status).toBe(400);
    });

    it('404s another school’s template', async () => {
      routeDb();
      const res = await authenticatedRequest('put', `${BASE}/${TEMPLATE_ID}/draft`).send({ doc: validDoc(), rev: 1 });
      expect(res.status).toBe(404);
    });
  });

  describe('delete', () => {
    const exists = [q.selectTemplateDraft, [{ template_id: TEMPLATE_ID, doc_type: DEFAULT.docType }]];

    it('409s while assigned', async () => {
      routeDb(new Map([exists, [q.countAssignmentsForTemplate, [{ count: 2 }]]]));
      const res = await authenticatedRequest('delete', `${BASE}/${TEMPLATE_ID}`);
      expect(res.status).toBe(409);
      expect(res.body.assignedCount).toBe(2);
    });

    it('archives a template that printed stored reports', async () => {
      routeDb(new Map([exists, [q.countAssignmentsForTemplate, [{ count: 0 }]], [q.templateVersionsUsed, [{ used: true }]], [q.archiveTemplate, [{ template_id: TEMPLATE_ID }]]]));
      const res = await authenticatedRequest('delete', `${BASE}/${TEMPLATE_ID}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ archived: true });
      expect(callsTo(q.deleteTemplate)).toHaveLength(0);
    });

    it('deletes an unused template, versions first, in a transaction', async () => {
      routeDb(new Map([exists, [q.countAssignmentsForTemplate, [{ count: 0 }]], [q.templateVersionsUsed, [{ used: false }]]]));
      const res = await authenticatedRequest('delete', `${BASE}/${TEMPLATE_ID}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ archived: false });
      const sqls = db._mockClient.query.mock.calls.map(([s]) => s);
      expect(sqls).toEqual(['BEGIN', q.unlinkPublishedVersion, q.deleteTemplateVersions, q.deleteTemplate, 'COMMIT']);
    });
  });

  describe('publish', () => {
    const draft = [q.selectTemplateDraft, [{ template_id: TEMPLATE_ID, doc_type: DEFAULT.docType, draft_doc: validDoc(), draft_rev: 3 }]];

    it('renders the worst-case sample, then takes the next version number', async () => {
      render.renderReportPdf.mockResolvedValueOnce({ pdf: Buffer.from('%PDF'), pageCount: 3, warnings: [{ code: 'text-shrunk', message: 'tight' }], engineVersion: 1 });
      routeDb(new Map([
        draft,
        [q.lockTemplate, [{ template_id: TEMPLATE_ID }]],
        [q.insertVersion, [{ version_id: VERSION_ID, version_no: 4, published_at: '2026-10-31T00:00:00Z' }]],
      ]));
      const res = await authenticatedRequest('post', `${BASE}/${TEMPLATE_ID}/publish`).send({ note: '  Fixed the footer ' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ versionId: VERSION_ID, versionNo: 4, publishedAt: '2026-10-31T00:00:00Z', pageCount: 3, warnings: [{ code: 'text-shrunk', message: 'tight' }] });
      const [{ template, data }] = render.renderReportPdf.mock.calls[0];
      expect(template).toEqual(validDoc());
      expect(data.student.id).toBe('sample-worst');
      const [[, params]] = callsTo(q.insertVersion);
      expect(params[0]).toBe(TEMPLATE_ID);
      expect(params[2]).toMatch(/^[0-9a-f]{64}$/);
      expect(params.slice(3)).toEqual([render.engineVersion(), 'Fixed the footer', TEST_ADMIN_USER_ID]);
      expect(callsTo(q.setPublishedVersion)[0][1]).toEqual([TEMPLATE_ID, VERSION_ID, TEST_ADMIN_USER_ID]);
    });

    it('422s a template that does not print, and saves no version', async () => {
      render.renderReportPdf.mockRejectedValueOnce(new Error('layout exploded'));
      routeDb(new Map([draft]));
      const res = await authenticatedRequest('post', `${BASE}/${TEMPLATE_ID}/publish`).send({});
      expect(res.status).toBe(422);
      expect(res.body.message).toContain('layout exploded');
      expect(callsTo(q.insertVersion)).toHaveLength(0);
    });

    it('hashes equal docs the same regardless of key order', () => {
      expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(stableStringify({ a: [{ c: 3, d: 2 }], b: 1 }));
    });
  });

  describe('discard draft', () => {
    it('400s a template that was never published', async () => {
      routeDb(new Map([[q.selectTemplateDetail, [{ ...summaryRow(), draft_doc: validDoc(), published_doc: null }]]]));
      const res = await authenticatedRequest('post', `${BASE}/${TEMPLATE_ID}/discard-draft`);
      expect(res.status).toBe(400);
    });
  });

  describe('assignments', () => {
    it.each([
      [{ docType: 'report_card', defaultKey: 'x', templateId: TEMPLATE_ID, grades: null, terms: null }, 'either'],
      [{ docType: 'report_card', grades: null, terms: null }, 'either'],
      [{ docType: DEFAULT.docType, defaultKey: DEFAULT.key, grades: ['9'], terms: null }, 'Unknown grade: 9'],
      [{ docType: DEFAULT.docType, defaultKey: DEFAULT.key, grades: [], terms: null }, 'at least one grade'],
      [{ docType: DEFAULT.docType, defaultKey: DEFAULT.key, grades: null, terms: [''] }, 'Pick a term'],
      [{ docType: DEFAULT.docType, defaultKey: DEFAULT.key, grades: null, terms: null, priority: 1.5 }, 'Priority'],
      [{ docType: DEFAULT.docType, defaultKey: 'nope', grades: null, terms: null }, 'Unknown built-in'],
      [{ docType: 'report_card', templateId: TEMPLATE_ID, grades: null, terms: null }, 'does not exist'],
    ])('refuses %j', async (body, message) => {
      routeDb();
      const res = await authenticatedRequest('post', `${BASE}/assignments`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain(message);
    });

    it('refuses a template of the other document type', async () => {
      routeDb(new Map([[q.selectAssignableTemplate, [{ template_id: TEMPLATE_ID, doc_type: 'progress_report', name: 'PR' }]]]));
      const res = await authenticatedRequest('post', `${BASE}/assignments`).send({ docType: 'report_card', templateId: TEMPLATE_ID, grades: null, terms: null });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('is a progress report');
    });

    it('creates one with grades in catalog order and terms de-duplicated', async () => {
      routeDb(new Map([
        [q.insertAssignment, [{ assignment_id: VERSION_ID }]],
        [q.selectAssignment, [{ assignment_id: VERSION_ID, doc_type: DEFAULT.docType, template_id: null, default_key: DEFAULT.key, grades: DEFAULT.grades, terms: ['Term 2'], priority: 50, created_at: 'now' }]],
      ]));
      const res = await authenticatedRequest('post', `${BASE}/assignments`)
        .send({ docType: DEFAULT.docType, defaultKey: DEFAULT.key, grades: ['8', 'jk', '1'], terms: ['Term 2', 'term 2 '], priority: 50 });
      expect(res.status).toBe(201);
      const [[, params]] = callsTo(q.insertAssignment);
      expect(params).toEqual(['ALHAADIACADEMY', DEFAULT.docType, null, DEFAULT.key, ['JK', '1', '8'], ['Term 2'], 50, TEST_ADMIN_USER_ID]);
      expect(res.body).toMatchObject({ assignmentId: VERSION_ID, name: DEFAULT.name, usable: true, priority: 50 });
    });

    it('PATCH keeps what it isn’t given', async () => {
      const existing = { assignment_id: VERSION_ID, doc_type: DEFAULT.docType, template_id: null, default_key: DEFAULT.key, grades: ['JK'], terms: null, priority: 100, created_at: 'now' };
      routeDb(new Map([[q.selectAssignment, [existing]], [q.updateAssignment, [{ assignment_id: VERSION_ID }]]]));
      const res = await authenticatedRequest('patch', `${BASE}/assignments/${VERSION_ID}`).send({ priority: 10 });
      expect(res.status).toBe(200);
      expect(callsTo(q.updateAssignment)[0][1]).toEqual([VERSION_ID, 'ALHAADIACADEMY', DEFAULT.docType, null, DEFAULT.key, ['JK'], null, 10]);
    });

    it('DELETE 404s another school’s assignment', async () => {
      routeDb();
      const res = await authenticatedRequest('delete', `${BASE}/assignments/${VERSION_ID}`);
      expect(res.status).toBe(404);
    });
  });

  describe('coverage', () => {
    it('lists the year’s terms and a cell per grade × term', async () => {
      routeDb(new Map([[q.selectTermNames, [{ name: 'Term 1' }, { name: 'Term 2' }]]]));
      const res = await authenticatedRequest('get', `${BASE}/coverage?docType=progress_report`);
      expect(res.status).toBe(200);
      expect(res.body.terms).toEqual(['Term 1', 'Term 2']);
      expect(res.body.grades).toEqual(['JK', 'SK', '1', '2', '3', '4', '5', '6', '7', '8']);
      expect(res.body.cells).toHaveLength(20);
      expect(res.body.engineMode).toBe('legacy');
      expect(callsTo(q.selectTermNames)[0][1]).toEqual(['ALHAADIACADEMY', db.DEFAULT_SCHOOL_YEAR_ID]);
    });

    it('needs a document type', async () => {
      const res = await authenticatedRequest('get', `${BASE}/coverage`);
      expect(res.status).toBe(400);
    });
  });

  describe('previews', () => {
    it('searches the school’s current students, escaping LIKE wildcards', async () => {
      routeDb(new Map([[q.searchStudents, [{ student_id: STUDENT_ID, name: 'Sam Example', grade: '4' }]]]));
      const res = await authenticatedRequest('get', `${BASE}/preview/students?grade=4&q=50%25_off`);
      expect(res.status).toBe(200);
      expect(res.body.students).toEqual([{ studentId: STUDENT_ID, name: 'Sam Example', grade: '4' }]);
      expect(callsTo(q.searchStudents)[0][1]).toEqual(['ALHAADIACADEMY', db.DEFAULT_SCHOOL_YEAR_ID, '4', '%50\\%\\_off%']);
    });

    it('preview/data 404s a student of another school', async () => {
      routeDb();
      const res = await authenticatedRequest('get', `${BASE}/preview/data?studentId=${STUDENT_ID}&docType=report_card&term=Term%201`);
      expect(res.status).toBe(404);
    });

    it('preview/sample: a sample student under the caller’s school and images', async () => {
      routeDb(new Map([
        [engineQ.selectSchoolByCode, [{ school_id: 'school-1', name: 'Example Academy', address: '1 Test Way', phone: '555-0100', email: 'office@example.test', timezone: 'America/Toronto' }]],
        [schoolAssetsQueries.getSchoolAssetsBySchoolId, [{ logo_path: 'logos/a.png', principal_signature_path: null, school_stamp_path: 'stamps/s.png' }]],
      ]));
      const res = await authenticatedRequest('get', `${BASE}/preview/sample?key=SK&docType=report_card`);
      expect(res.status).toBe(200);
      expect(res.body.school).toEqual({
        code: 'ALHAADIACADEMY', name: 'Example Academy', address: '1 Test Way', phone: '555-0100', email: 'office@example.test',
        // The website is the contact email's domain, as the paper footers print it.
        website: 'www.example.test', principal: '', board: '',
      });
      expect(res.body.assets).toEqual({ logo: 'https://mock-signed-url.com', principalSignature: null, stamp: 'https://mock-signed-url.com', teacherSignature: null });
      expect(res.body.student.grade).toBe('SK');
      expect(res.body.meta.docType).toBe('report_card');
    });

    it('preview/sample 400s an unknown key, listing the valid ones', async () => {
      const res = await authenticatedRequest('get', `${BASE}/preview/sample?key=nope&docType=report_card`);
      expect(res.status).toBe(400);
      expect(res.body.samples).toEqual(kit.SAMPLE_OPTIONS.map((o) => o.key));
    });

    it('preview/pdf prints a sample with page count and warnings headers', async () => {
      routeDb();
      render.renderReportPdf.mockResolvedValueOnce({ pdf: Buffer.from('%PDF-1.7 preview'), pageCount: 2, warnings: [{ code: 'text-clipped', message: 'Too long, "really"' }], engineVersion: 1 });
      const res = await authenticatedRequest('post', `${BASE}/preview/pdf`).send({ doc: validDoc(), docType: DEFAULT.docType, sample: 'worst' });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['x-report-pages']).toBe('2');
      expect(JSON.parse(decodeURIComponent(res.headers['x-report-warnings']))).toEqual([{ code: 'text-clipped', message: 'Too long, "really"' }]);
      expect(render.inlineAssets).toHaveBeenCalled();
      expect(render.renderReportPdf.mock.calls[0][0].data.school.code).toBe('ALHAADIACADEMY');
    });

    it('preview/pdf 400s an invalid doc', async () => {
      const res = await authenticatedRequest('post', `${BASE}/preview/pdf`).send({ doc: { nope: true }, docType: 'report_card' });
      expect(res.status).toBe(400);
      expect(res.body.errors.length).toBeGreaterThan(0);
      expect(render.renderReportPdf).not.toHaveBeenCalled();
    });
  });

  describe('field values', () => {
    it('refuses keys the printing template doesn’t have', async () => {
      routeDb(new Map([[q.selectSchoolStudent, [{ student_id: STUDENT_ID, name: 'Sam Example', grade: '4', school: 'ALHAADIACADEMY' }]]]));
      const res = await authenticatedRequest('put', `${BASE}/field-values`)
        .send({ docType: 'progress_report', term: 'Term 1', studentId: STUDENT_ID, values: { principal_note: 'Hi' } });
      expect(res.status).toBe(400);
      expect(res.body.unknown).toEqual(['principal_note']);
      expect(callsTo(q.upsertFieldValue)).toHaveLength(0);
    });

    it('needs a known grade to list', async () => {
      const res = await authenticatedRequest('get', `${BASE}/field-values?docType=report_card&term=Term%201&grade=13`);
      expect(res.status).toBe(400);
    });
  });
});
