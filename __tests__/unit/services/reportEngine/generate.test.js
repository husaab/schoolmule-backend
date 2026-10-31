// Engine generation (services/reportEngine/generate.js): printing a stored
// report with a template, and the REPORT_ENGINE modes around the legacy
// generators. The renderer, the assembler and the resolver are mocked; the
// database answers by SQL text.

jest.mock('../../../../logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }));
jest.mock('../../../../services/reportEngine/render', () => ({
  renderReportPdf: jest.fn(),
  inlineAssets: jest.fn(async (data) => ({ ...data, inlined: true })),
  launchReportBrowser: jest.fn(),
  reportKit: jest.fn(() => ({ DEFAULT_TEMPLATES: [] })),
}));
jest.mock('../../../../services/reportEngine/data', () => ({ assembleReportData: jest.fn() }));
jest.mock('../../../../services/reportEngine/templates/resolve', () => ({ resolveTemplate: jest.fn() }));

const db = require('../../../__mocks__/config/database');
const supabase = require('../../../__mocks__/config/supabaseClient');
const logger = require('../../../../logger');
const render = require('../../../../services/reportEngine/render');
const { assembleReportData } = require('../../../../services/reportEngine/data');
const { resolveTemplate } = require('../../../../services/reportEngine/templates/resolve');
const { ReportSkip } = require('../../../../services/reportEngine/data/errors');
const studentQueries = require('../../../../queries/student.queries');
const q = require('../../../../queries/reportTemplates.queries');
const gen = require('../../../../services/reportEngine/generate');

const SID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const TEMPLATE_ID = '44444444-4444-4444-8444-444444444444';

const student = (fields = {}) => ({ student_id: SID, name: 'Sam Example', school: 'PLAYGROUND', grade: '4', ...fields });
const resolvedTemplate = (fields = []) => ({
  doc: { schemaVersion: 1, docType: 'progress_report', fields },
  source: 'assignment',
  templateId: TEMPLATE_ID,
  versionId: VERSION_ID,
  defaultKey: null,
  name: 'Ours',
  assignmentId: null,
});
const reportData = () => ({ dataVersion: 1, student: { name: 'Sam Example' }, assets: {}, extra: {} });

/** Answer db.query by SQL: the student row, stored field values, report upserts. */
function routeDb({ studentRow = student(), stored = [], recordRow = { student_id: SID } } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (sql === studentQueries.selectStudentById) return { rows: studentRow ? [studentRow] : [] };
    if (sql === q.selectFieldValues) return { rows: stored };
    if (sql === q.upsertEngineProgressReport) return { rows: [recordRow] };
    return { rows: [], rowCount: 0 };
  });
}
const callsTo = (sql) => db.query.mock.calls.filter(([s]) => s === sql);

const ORIGINAL_MODE = process.env.REPORT_ENGINE;
afterEach(() => {
  if (ORIGINAL_MODE === undefined) delete process.env.REPORT_ENGINE;
  else process.env.REPORT_ENGINE = ORIGINAL_MODE;
});

beforeEach(() => {
  render.renderReportPdf.mockResolvedValue({ pdf: Buffer.from('%PDF-engine'), pageCount: 2, warnings: [{ code: 'text-shrunk', message: 'x' }], engineVersion: 1 });
  render.inlineAssets.mockImplementation(async (data) => ({ ...data, inlined: true }));
  assembleReportData.mockImplementation(async () => reportData());
});

describe('reportFilePath: the legacy generators’ storage paths', () => {
  const path = (docType, grade) => gen.reportFilePath({ docType, school: 'Play Ground', studentName: 'Sam  Example', grade, term: 'Term 1' });
  it.each([
    ['report_card', '4', 'PLAYGROUND/Sam  Example_Term 1_report_card.pdf'],
    ['report_card', 'JK', 'PLAYGROUND/Sam_Example_Term_1_jk_report_card.pdf'],
    ['report_card', 'SK', 'PLAYGROUND/Sam_Example_Term_1_sk_report_card.pdf'],
    ['progress_report', '4', 'PLAYGROUND/Sam_Example_Term_1_progress_report.pdf'],
    ['progress_report', 'JK', 'PLAYGROUND/Sam_Example_Term_1_jk_progress_report.pdf'],
    ['progress_report', 'sk', 'PLAYGROUND/Sam_Example_Term_1_sk_progress_report.pdf'],
  ])('%s grade %s → %s', (docType, grade, expected) => {
    expect(path(docType, grade)).toBe(expected);
  });
});

describe('generateWithEngine', () => {
  it('is null when no template resolves (legacy prints), without assembling anything', async () => {
    routeDb();
    resolveTemplate.mockResolvedValue(null);
    expect(await gen.generateWithEngine({ studentId: SID, docType: 'progress_report', term: 'Term 1' })).toBeNull();
    expect(assembleReportData).not.toHaveBeenCalled();
    expect(render.renderReportPdf).not.toHaveBeenCalled();
  });

  it('is null for a missing student (legacy answers "Student not found" its own way)', async () => {
    routeDb({ studentRow: null });
    expect(await gen.generateWithEngine({ studentId: SID, docType: 'report_card', term: 'Term 1' })).toBeNull();
    expect(resolveTemplate).not.toHaveBeenCalled();
  });

  it('refuses while a required extra field is empty, naming the fields and the student', async () => {
    routeDb({ stored: [{ field_key: 'citizenship', value: 'Excellent' }] });
    resolveTemplate.mockResolvedValue(resolvedTemplate([
      { key: 'citizenship', label: 'Citizenship', type: 'text', required: true },
      { key: 'principal_note', label: 'Principal note', type: 'longtext', required: true },
      { key: 'next_steps', label: 'Next steps', type: 'text', required: true, defaultValue: 'Keep reading' },
    ]));
    const err = await gen.generateWithEngine({ studentId: SID, docType: 'progress_report', term: 'Term 1' }).catch((e) => e);
    expect(err).toBeInstanceOf(ReportSkip);
    expect(err.status).toBe(422);
    expect(err.message).toBe('Fill in Principal note for Sam Example first');
    expect(render.renderReportPdf).not.toHaveBeenCalled();
    expect(supabase._mockStorage.upload).not.toHaveBeenCalled();
  });

  it('merges stored values over field defaults into data.extra, prints, uploads and records', async () => {
    routeDb({ stored: [{ field_key: 'note', value: 'Great term' }, { field_key: 'blank', value: '  ' }] });
    const resolved = resolvedTemplate([
      { key: 'note', label: 'Note', type: 'text', defaultValue: 'n/a' },
      { key: 'club', label: 'Club', type: 'text', defaultValue: 'Chess' },
      { key: 'blank', label: 'Blank', type: 'text' },
    ]);
    resolveTemplate.mockResolvedValue(resolved);

    const out = await gen.generateWithEngine({ studentId: SID, docType: 'progress_report', term: 'Term 1' });

    expect(resolveTemplate).toHaveBeenCalledWith(expect.objectContaining({ school: 'PLAYGROUND', docType: 'progress_report', grade: '4', term: 'Term 1' }));
    const [{ template, data }] = render.renderReportPdf.mock.calls[0];
    expect(template).toBe(resolved.doc);
    expect(data.inlined).toBe(true);
    expect(data.extra).toEqual({ note: 'Great term', club: 'Chess' });

    expect(supabase.storage.from).toHaveBeenCalledWith('progress-reports');
    expect(supabase._mockStorage.upload).toHaveBeenCalledWith(
      'PLAYGROUND/Sam_Example_Term_1_progress_report.pdf',
      Buffer.from('%PDF-engine'),
      { contentType: 'application/pdf', upsert: true },
    );
    const [[, params]] = callsTo(q.upsertEngineProgressReport);
    expect(params).toEqual([SID, 'Term 1', 'Sam Example', '4', 'PLAYGROUND/Sam_Example_Term_1_progress_report.pdf', 'PLAYGROUND',
      VERSION_ID, null, 1, JSON.stringify([{ code: 'text-shrunk', message: 'x' }])]);
    expect(out).toMatchObject({
      studentId: SID, studentName: 'Sam Example', term: 'Term 1', filePath: 'PLAYGROUND/Sam_Example_Term_1_progress_report.pdf',
      grade: '4', record: { student_id: SID }, pageCount: 2, templateId: TEMPLATE_ID, versionId: VERSION_ID,
    });
  });

  it('writes a JK report card to report-cards under the _jk_ name, keyed by the built-in that printed it', async () => {
    routeDb({ studentRow: student({ grade: 'JK' }) });
    resolveTemplate.mockResolvedValue({ ...resolvedTemplate(), source: 'default', templateId: null, versionId: null, defaultKey: 'report-card-jk' });
    await gen.generateWithEngine({ studentId: SID, docType: 'report_card', term: 'Term 2' });
    expect(supabase.storage.from).toHaveBeenCalledWith('report-cards');
    expect(supabase._mockStorage.upload.mock.calls[0][0]).toBe('PLAYGROUND/Sam_Example_Term_2_jk_report_card.pdf');
    const [[, params]] = callsTo(q.upsertEngineReportCard);
    expect(params.slice(6, 8)).toEqual([null, 'report-card-jk']);
  });

  it('fails (no record) when the upload fails', async () => {
    routeDb();
    resolveTemplate.mockResolvedValue(resolvedTemplate());
    supabase._mockStorage.upload.mockResolvedValueOnce({ data: null, error: { message: 'nope' } });
    const err = await gen.generateWithEngine({ studentId: SID, docType: 'progress_report', term: 'Term 1' }).catch((e) => e);
    expect(err.message).toBe('Upload to storage failed');
    expect(err.reportEngine).toMatchObject({ templateId: TEMPLATE_ID, versionId: VERSION_ID });
    expect(callsTo(q.upsertEngineProgressReport)).toHaveLength(0);
  });
});

describe('withReportEngine: REPORT_ENGINE modes', () => {
  const run = (legacy, opts = {}, shape = gen.progressReportResult) => gen.withReportEngine(
    { docType: 'progress_report', studentId: SID, term: 'Term 1', opts, shape },
    legacy,
  );
  const legacyResult = { studentId: SID, studentName: 'Sam Example', term: 'Term 1', filePath: 'legacy.pdf' };

  it('legacy (unset): only the legacy generator, no engine reads', async () => {
    delete process.env.REPORT_ENGINE;
    const legacy = jest.fn().mockResolvedValue(legacyResult);
    const opts = { browser: 'shared' };
    expect(await run(legacy, opts)).toBe(legacyResult);
    expect(legacy).toHaveBeenCalledWith(opts);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('an unknown value is legacy', async () => {
    process.env.REPORT_ENGINE = 'sometimes';
    const legacy = jest.fn().mockResolvedValue(legacyResult);
    await run(legacy);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('new: the engine prints, shaped like the legacy return value', async () => {
    process.env.REPORT_ENGINE = 'new';
    routeDb();
    resolveTemplate.mockResolvedValue(resolvedTemplate());
    const legacy = jest.fn();
    const out = await run(legacy);
    expect(legacy).not.toHaveBeenCalled();
    expect(out).toEqual({
      studentId: SID, studentName: 'Sam Example', term: 'Term 1',
      filePath: 'PLAYGROUND/Sam_Example_Term_1_progress_report.pdf', recordId: { student_id: SID },
    });
  });

  it('new: shapes per legacy path (grades 1-8 report card message, JK/SK object)', () => {
    const r = { studentId: SID, studentName: 'S', term: 'T', filePath: 'p', grade: '4', record: { a: 1 } };
    expect(gen.reportCardResult(r)).toBe('Report card generated and uploaded');
    expect(gen.reportCardResult({ ...r, grade: 'SK' })).toEqual({ studentId: SID, studentName: 'S', term: 'T', filePath: 'p' });
    expect(gen.progressReportResult({ ...r, grade: 'JK' })).toEqual({ studentId: SID, studentName: 'S', term: 'T', filePath: 'p' });
    expect(gen.kindergartenResult(r)).toEqual({ studentId: SID, studentName: 'S', term: 'T', filePath: 'p' });
  });

  it('new: no template → legacy prints, and any old engine provenance on the row is cleared', async () => {
    process.env.REPORT_ENGINE = 'new';
    routeDb();
    resolveTemplate.mockResolvedValue(null);
    const legacy = jest.fn().mockResolvedValue(legacyResult);
    expect(await run(legacy, { browser: 'shared' })).toBe(legacyResult);
    expect(legacy).toHaveBeenCalledWith(expect.objectContaining({ browser: 'shared', [gen.ENGINE_HANDLED]: true }));
    expect(callsTo(q.clearEngineProgressReport)).toEqual([[q.clearEngineProgressReport, [SID, 'Term 1']]]);
  });

  it('new: an engine failure is logged with the template and student, and legacy prints', async () => {
    process.env.REPORT_ENGINE = 'new';
    routeDb();
    resolveTemplate.mockResolvedValue(resolvedTemplate());
    render.renderReportPdf.mockRejectedValueOnce(new Error('Chromium crashed'));
    const legacy = jest.fn().mockResolvedValue(legacyResult);
    expect(await run(legacy)).toBe(legacyResult);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ studentId: SID, templateId: TEMPLATE_ID, versionId: VERSION_ID, err: expect.any(Error) }),
      expect.stringContaining('legacy'),
    );
    expect(callsTo(q.clearEngineProgressReport)).toHaveLength(1);
  });

  it('new: a ReportSkip (required field) reaches the caller; legacy does not run', async () => {
    process.env.REPORT_ENGINE = 'new';
    routeDb();
    resolveTemplate.mockResolvedValue(resolvedTemplate([{ key: 'note', label: 'Note', type: 'text', required: true }]));
    const legacy = jest.fn();
    await expect(run(legacy)).rejects.toMatchObject({ name: 'ReportSkip', status: 422 });
    expect(legacy).not.toHaveBeenCalled();
  });

  it('new: a nested call (legacy routing on to another generator) does not run the engine again', async () => {
    process.env.REPORT_ENGINE = 'new';
    const legacy = jest.fn().mockResolvedValue(legacyResult);
    await run(legacy, { [gen.ENGINE_HANDLED]: true });
    expect(legacy).toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('new: uses the bulk run’s engine browser', async () => {
    process.env.REPORT_ENGINE = 'new';
    routeDb();
    resolveTemplate.mockResolvedValue(resolvedTemplate());
    const engine = { browser: jest.fn().mockResolvedValue('engine-browser') };
    await run(jest.fn(), { browser: 'legacy-browser', engine });
    expect(render.renderReportPdf.mock.calls[0][0].browser).toBe('engine-browser');
  });

  it('shadow: legacy prints and uploads; the engine lays out without uploading and logs it', async () => {
    process.env.REPORT_ENGINE = 'shadow';
    routeDb();
    resolveTemplate.mockResolvedValue(resolvedTemplate());
    const legacy = jest.fn().mockResolvedValue(legacyResult);
    expect(await run(legacy)).toBe(legacyResult);
    expect(render.renderReportPdf).toHaveBeenCalledTimes(1);
    expect(supabase._mockStorage.upload).not.toHaveBeenCalled();
    expect(callsTo(q.upsertEngineProgressReport)).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ pageCount: 2, templateId: TEMPLATE_ID }), 'Report engine shadow render');
  });

  it('shadow: an engine failure never fails the request', async () => {
    process.env.REPORT_ENGINE = 'shadow';
    routeDb();
    resolveTemplate.mockRejectedValue(new Error('resolver down'));
    const legacy = jest.fn().mockResolvedValue(legacyResult);
    expect(await run(legacy)).toBe(legacyResult);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ studentId: SID }), 'Report engine shadow render failed');
  });

  it('shadow: a legacy failure still fails (and skips the shadow render)', async () => {
    process.env.REPORT_ENGINE = 'shadow';
    const legacy = jest.fn().mockRejectedValue(new Error('legacy broke'));
    await expect(run(legacy)).rejects.toThrow('legacy broke');
    expect(render.renderReportPdf).not.toHaveBeenCalled();
  });
});

describe('reportEngineSession', () => {
  it('launches one browser on first use and closes it', async () => {
    process.env.REPORT_ENGINE = 'new';
    const browser = { close: jest.fn().mockResolvedValue() };
    render.launchReportBrowser.mockResolvedValue(browser);
    const session = gen.reportEngineSession();
    expect(await session.browser()).toBe(browser);
    expect(await session.browser()).toBe(browser);
    expect(render.launchReportBrowser).toHaveBeenCalledTimes(1);
    await session.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('never launches under REPORT_ENGINE=legacy, and close() is a no-op', async () => {
    delete process.env.REPORT_ENGINE;
    const session = gen.reportEngineSession();
    expect(await session.browser()).toBeNull();
    await session.close();
    expect(render.launchReportBrowser).not.toHaveBeenCalled();
  });

  it('a failed launch is not thrown again by close()', async () => {
    process.env.REPORT_ENGINE = 'new';
    render.launchReportBrowser.mockRejectedValue(new Error('no chromium'));
    const session = gen.reportEngineSession();
    await expect(session.browser()).rejects.toThrow('no chromium');
    await expect(session.close()).resolves.toBeUndefined();
  });
});
