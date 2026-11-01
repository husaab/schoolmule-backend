// Template resolution (services/reportEngine/templates/resolve.js): which
// template prints a student's report. The engine's built-in list is replaced
// by a fixed one so these tests don't change as reportkit gains defaults.

jest.mock('../../../../logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }));

const mockDefaults = [
  { key: 'progress-jk', name: 'JK progress report', description: '', docType: 'progress_report', grades: ['JK'] },
  { key: 'progress-sk', name: 'SK progress report', description: '', docType: 'progress_report', grades: ['SK'] },
  { key: 'report-card-jk', name: 'JK report card', description: '', docType: 'report_card', grades: ['JK'] },
];
jest.mock('../../../../services/reportEngine/render', () => ({
  reportKit: () => ({
    DEFAULT_TEMPLATES: mockDefaults,
    defaultTemplate: (key) => {
      const t = mockDefaults.find((d) => d.key === key);
      return t ? { schemaVersion: 1, docType: t.docType, built: key, fields: [] } : null;
    },
  }),
}));

const q = require('../../../../queries/reportTemplates.queries');
const {
  resolveTemplate, coverage, pickTarget, compareAssignments, defaultFor, GRADES,
} = require('../../../../services/reportEngine/templates/resolve');

const T1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const T2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const V1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const V2 = 'bbbbbbbb-0000-4000-8000-000000000002';

let seq = 0;
/** An assignment row as listAssignments returns it. */
function row(fields = {}) {
  seq += 1;
  return {
    assignment_id: `cccccccc-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    doc_type: 'progress_report',
    template_id: null,
    default_key: null,
    grades: null,
    terms: null,
    priority: 100,
    created_at: '2026-10-01T00:00:00Z',
    template_name: null,
    published_version_id: null,
    template_archived_at: null,
    ...fields,
  };
}
const toTemplate = (templateId, versionId, name, fields = {}) => row({ template_id: templateId, published_version_id: versionId, template_name: name, ...fields });

function fakeClient({ assignments = [], docs = {} } = {}) {
  return {
    query: jest.fn(async (sql, params) => {
      if (sql === q.listAssignments) return { rows: assignments.filter((a) => a.doc_type === params[1]) };
      if (sql === q.selectPublishedDoc) return { rows: docs[params[0]] ? [{ doc: docs[params[0]] }] : [] };
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
}

const pick = (assignments, grade, term, docType = 'progress_report') => pickTarget(assignments, { docType, grade, term });

describe('pickTarget: which assignment wins', () => {
  it('a lower priority wins over a more specific one', () => {
    const broad = toTemplate(T1, V1, 'Broad', { priority: 10 });
    const narrow = toTemplate(T2, V2, 'Narrow', { priority: 20, grades: ['4'], terms: ['Term 1'] });
    expect(pick([narrow, broad], '4', 'Term 1')).toMatchObject({ source: 'assignment', templateId: T1, versionId: V1, name: 'Broad' });
  });

  it('at equal priority, grades set beats grades open, then terms set beats terms open', () => {
    const open = toTemplate(T1, V1, 'Open');
    const byTerm = toTemplate(T1, V1, 'By term', { terms: ['Term 2'] });
    const byGrade = toTemplate(T2, V2, 'By grade', { grades: ['5'] });
    const byBoth = toTemplate(T2, V2, 'By both', { grades: ['5'], terms: ['Term 2'] });
    expect(pick([open, byTerm, byGrade, byBoth], '5', 'Term 2').name).toBe('By both');
    expect(pick([open, byTerm, byGrade], '5', 'Term 2').name).toBe('By grade');
    expect(pick([open, byTerm], '5', 'Term 2').name).toBe('By term');
    expect(pick([open, byTerm], '5', 'Term 1').name).toBe('Open');
  });

  it('then the newest', () => {
    const older = toTemplate(T1, V1, 'Older', { created_at: '2026-09-01T00:00:00Z' });
    const newer = toTemplate(T2, V2, 'Newer', { created_at: '2026-10-15T00:00:00Z' });
    expect(pick([older, newer], '3', 'Term 1').name).toBe('Newer');
    expect([older, newer].sort(compareAssignments)[0]).toBe(newer);
  });

  it('matches term names case- and space-insensitively', () => {
    const a = toTemplate(T1, V1, 'T2 only', { terms: [' TERM 2 '] });
    expect(pick([a], '4', 'term 2')).toMatchObject({ templateId: T1 });
    expect(pick([a], '4', 'Term 2')).toMatchObject({ templateId: T1 });
    expect(pick([a], '4', 'Term 1')).toBeNull();
  });

  it('matches grades, and only its own document type', () => {
    const a = toTemplate(T1, V1, 'Grades 1-3', { grades: ['1', '2', '3'] });
    expect(pick([a], '2', 'Term 1')).toMatchObject({ templateId: T1 });
    expect(pick([a], '4', 'Term 1')).toBeNull();
    expect(pick([a], '2', 'Term 1', 'report_card')).toBeNull();
  });

  it('passes over a template that was never published, or is archived', () => {
    const unpublished = toTemplate(T1, null, 'Draft only', { priority: 1 });
    const archived = toTemplate(T2, V2, 'Archived', { priority: 2, template_archived_at: '2026-10-20T00:00:00Z' });
    const fallback = toTemplate(T2, V2, 'Live', { priority: 3 });
    expect(pick([unpublished, archived, fallback], '6', 'Term 1').name).toBe('Live');
    expect(pick([unpublished, archived], '6', 'Term 1')).toBeNull();
  });

  it('a built-in key prints that built-in; an unknown or wrong-type key is passed over', () => {
    const builtIn = row({ default_key: 'progress-sk', grades: ['4'] });
    expect(pick([builtIn], '4', 'Term 1')).toMatchObject({ source: 'assignment', templateId: null, versionId: null, defaultKey: 'progress-sk', name: 'SK progress report' });
    const unknown = row({ default_key: 'report-card-t1t2final', priority: 1, grades: ['4'] });
    const wrongType = row({ default_key: 'report-card-jk', priority: 2, grades: ['4'] });
    expect(pick([unknown, wrongType, builtIn], '4', 'Term 1').defaultKey).toBe('progress-sk');
    expect(pick([unknown, wrongType], '4', 'Term 1')).toBeNull();
  });

  it('falls back to the first built-in for the grade, else null (legacy)', () => {
    expect(pick([], 'JK', 'Term 1')).toMatchObject({ source: 'default', defaultKey: 'progress-jk', assignmentId: null });
    expect(pick([], 'sk', 'Term 1')).toMatchObject({ source: 'default', defaultKey: 'progress-sk' });
    expect(pick([], '4', 'Term 1')).toBeNull();
    expect(pick([], 'JK', 'Term 1', 'report_card')).toMatchObject({ defaultKey: 'report-card-jk' });
    expect(defaultFor('report_card', '7')).toBeNull();
  });

  it('an assignment beats the built-in default', () => {
    const a = toTemplate(T1, V1, 'Our JK', { grades: ['JK'] });
    expect(pick([a], 'JK', 'Term 1')).toMatchObject({ source: 'assignment', templateId: T1 });
  });
});

describe('resolveTemplate', () => {
  it("prints a template's published version", async () => {
    const doc = { schemaVersion: 1, docType: 'progress_report', fields: [{ key: 'note', label: 'Note', type: 'text' }] };
    const client = fakeClient({ assignments: [toTemplate(T1, V1, 'Ours', { grades: ['4'] })], docs: { [V1]: doc } });
    const out = await resolveTemplate({ school: 'PLAYGROUND', docType: 'progress_report', grade: '4', term: 'Term 1', client });
    expect(out).toEqual({ doc, source: 'assignment', templateId: T1, versionId: V1, defaultKey: null, name: 'Ours', assignmentId: expect.any(String) });
    expect(client.query).toHaveBeenCalledWith(q.listAssignments, ['PLAYGROUND', 'progress_report']);
    expect(client.query).toHaveBeenCalledWith(q.selectPublishedDoc, [V1]);
  });

  it('builds a built-in default (no version read)', async () => {
    const client = fakeClient();
    const out = await resolveTemplate({ school: 'PLAYGROUND', docType: 'progress_report', grade: 'JK', term: 'Term 2', client });
    expect(out).toMatchObject({ source: 'default', defaultKey: 'progress-jk', doc: { built: 'progress-jk' } });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('is null when nothing prints the grade (the caller runs legacy)', async () => {
    const out = await resolveTemplate({ school: 'PLAYGROUND', docType: 'progress_report', grade: '4', term: 'Term 1', client: fakeClient() });
    expect(out).toBeNull();
  });
});

describe('coverage', () => {
  it('names what prints in every grade × term', async () => {
    const client = fakeClient({ assignments: [toTemplate(T1, V1, 'Upper T2', { grades: ['7', '8'], terms: ['Term 2'] })] });
    const cells = await coverage({ school: 'PLAYGROUND', docType: 'progress_report', terms: ['Term 1', 'Term 2'], client });
    expect(cells).toHaveLength(GRADES.length * 2);
    const at = (grade, term) => cells.find((c) => c.grade === grade && c.term === term);
    expect(at('8', 'Term 2')).toMatchObject({ source: 'assignment', name: 'Upper T2', templateId: T1 });
    expect(at('8', 'Term 1')).toMatchObject({ source: 'legacy', name: 'Legacy layout', templateId: null, defaultKey: null });
    expect(at('JK', 'Term 1')).toMatchObject({ source: 'default', defaultKey: 'progress-jk', name: 'JK progress report' });
    // One read for the whole matrix.
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
