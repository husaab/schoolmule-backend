/*
  controllers/reportTemplates.controller.js
  Report Template Designer (/api/report-templates, routes/reportTemplates.routes.js).

  A school designs its own report cards and progress reports as reportkit
  TemplateDoc JSON: a draft edited in place (draftRev guards concurrent
  saves), published as immutable versions, and assigned to grades and terms.
  Previews lay a draft out for a real student or a sample one. Extra field
  values are what staff fill in per student for a template's custom fields.

  Every id is the caller's school's: anything else reads as missing (404).
  Bodies are plain JSON (no { status, data } envelope); errors carry
  { status: 'failed', message } plus details where noted.
*/

const crypto = require('crypto');
const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/reportTemplates.queries');
const render = require('../services/reportEngine/render');
const { ReportSkip } = require('../services/reportEngine/data/errors');
const { GRADES, resolveTemplate, coverage, defaultByKey } = require('../services/reportEngine/templates/resolve');
const { engineMode } = require('../services/reportEngine/generate');
const { loadFieldValues, mergeExtras, isBlank } = require('../services/reportEngine/fields');
const { sampleKeys, sampleWithSchool, studentPreviewData } = require('../services/reportEngine/preview');

const DOC_TYPES = ['report_card', 'progress_report'];
const DOC_LABEL = { report_card: 'report card', progress_report: 'progress report' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 100;
const MAX_NOTE = 500;
const MAX_TERM = 60;
const MAX_TERMS = 20;
const MAX_VALUE = 10000;
const MAX_HEADER_WARNINGS = 40;
const DEFAULT_SAMPLE = 'SK';
const PUBLISH_SAMPLE = 'worst';

const kit = () => render.reportKit();
const fail = (res, status, message, extra = {}) => res.status(status).json({ status: 'failed', message, ...extra });
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const yearOf = (req) => (req.schoolYear && req.schoolYear.schoolYearId) || null;
const notFound = (res) => fail(res, 404, 'Template not found');

// ─────────────────────────────────────────────────────────── shapes ──

const toSummary = (row) => ({
  templateId: row.template_id,
  name: row.name,
  docType: row.doc_type,
  baseKey: row.base_key ?? null,
  draftRev: row.draft_rev,
  updatedAt: row.updated_at,
  hasUnpublishedChanges: !!row.has_unpublished_changes,
  published: row.published_version_id
    ? { versionId: row.published_version_id, versionNo: row.published_version_no, publishedAt: row.published_at }
    : null,
  assignedCount: row.assigned_count ?? 0,
});

const toDetail = (row) => ({
  template: toSummary(row),
  draft: row.draft_doc,
  draftRev: row.draft_rev,
  publishedDoc: row.published_doc ?? null,
});

const toDefault = (t) => ({ key: t.key, name: t.name, description: t.description || '', docType: t.docType, grades: t.grades || [] });

const toVersion = (row) => ({
  versionId: row.version_id,
  versionNo: row.version_no,
  note: row.note ?? null,
  publishedAt: row.published_at,
  publishedBy: row.published_by_name || row.published_by_username || null,
  engineVersion: row.engine_version ?? null,
  isPublished: !!row.is_published,
});

/** Can the resolver print from this assignment right now? */
function assignmentUsable(row) {
  if (row.template_id) return !!row.published_version_id && !row.template_archived_at;
  const def = defaultByKey(row.default_key);
  return !!def && def.docType === row.doc_type;
}

const toAssignment = (row) => {
  const def = row.default_key ? defaultByKey(row.default_key) : null;
  return {
    assignmentId: row.assignment_id,
    docType: row.doc_type,
    templateId: row.template_id ?? null,
    defaultKey: row.default_key ?? null,
    name: row.template_id ? row.template_name : (def ? def.name : row.default_key),
    grades: row.grades ?? null,
    terms: row.terms ?? null,
    priority: row.priority,
    createdAt: row.created_at,
    usable: assignmentUsable(row),
  };
};

// ───────────────────────────────────────────────────────── helpers ──

/** The doc's problems as the engine (and the designer) sees them, plus its document type. */
function docErrors(doc, docType) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['The template is missing.'];
  const { errors } = kit().validateTemplate(doc);
  const out = [...(errors || [])];
  if (docType && doc.docType && doc.docType !== docType) {
    out.push(`This template is a ${DOC_LABEL[docType]}; the document says ${DOC_LABEL[doc.docType] || doc.docType}.`);
  }
  return out;
}

const invalid = (res, errors) => fail(res, 400, 'The template has problems. Fix them and try again.', { errors });

function readName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return { error: 'A template needs a name' };
  if (name.length > MAX_NAME) return { error: `Template names are ${MAX_NAME} characters or fewer` };
  return { name };
}

const DUPLICATE_NAME = 'A template with this name already exists';

/** Canonical JSON (sorted keys) so equal docs hash the same. */
function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}
const sha256 = (doc) => crypto.createHash('sha256').update(stableStringify(doc)).digest('hex');

/** An empty page: a built-in's page set-up, theme, scales and mark rules, nothing printed. */
function blankDoc(docType) {
  const defaults = kit().DEFAULT_TEMPLATES || [];
  const base = defaults.find((t) => t.docType === docType) || defaults[0];
  const doc = base.build();
  return {
    ...doc,
    docType,
    fields: [],
    header: { ...doc.header, elements: [] },
    footer: { ...doc.footer, elements: [] },
    firstHeader: null,
    firstFooter: null,
    blocks: [],
  };
}

async function inTransaction(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function loadSummary(templateId, school) {
  const { rows } = await db.query(q.selectTemplateSummary, [templateId, school]);
  return rows[0] || null;
}

async function loadDetail(templateId, school) {
  const { rows } = await db.query(q.selectTemplateDetail, [templateId, school]);
  return rows[0] || null;
}

/** The school's term names: the selected year's, else every year's. */
async function schoolTermNames(req) {
  const { rows } = await db.query(q.selectTermNames, [req.user.school, yearOf(req)]);
  if (rows.length > 0) return rows.map((r) => r.name);
  const { rows: all } = await db.query(q.selectAllTermNames, [req.user.school]);
  return all.map((r) => r.name);
}

/** The term a preview uses when none is given: the active one, else Term 1. */
async function defaultTerm(req) {
  const { rows } = await db.query(q.selectActiveTermName, [req.user.school, yearOf(req)]);
  return (rows[0] && rows[0].name) || 'Term 1';
}

function readTerm(raw) {
  const term = typeof raw === 'string' ? raw.trim() : '';
  if (!term) return { error: 'Pick a term' };
  if (term.length > MAX_TERM) return { error: 'That term name is too long' };
  return { term };
}

async function loadSchoolStudent(studentId, school) {
  if (!isUuid(studentId)) return null;
  const { rows } = await db.query(q.selectSchoolStudent, [studentId, school]);
  return rows[0] || null;
}

const STUDENT_NOT_FOUND = 'Student not found';

// ──────────────────────────────────────────────────────── templates ──

// GET /api/report-templates
const listTemplates = async (req, res) => {
  try {
    const { rows } = await db.query(q.listTemplates, [req.user.school]);
    return res.status(200).json({
      templates: rows.map(toSummary),
      defaults: (kit().DEFAULT_TEMPLATES || []).map(toDefault),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to list report templates');
    return fail(res, 500, 'Error loading report templates');
  }
};

// POST /api/report-templates  { name, docType, fromDefault?, fromTemplateId? }
const createTemplate = async (req, res) => {
  const { school, userId } = req.user;
  const body = req.body ?? {};
  const named = readName(body.name);
  if (named.error) return fail(res, 400, named.error);
  const { docType } = body;
  if (!DOC_TYPES.includes(docType)) return fail(res, 400, 'Pick a document type: report_card or progress_report');
  if (body.fromDefault && body.fromTemplateId) return fail(res, 400, 'Start from a built-in template or one of yours, not both');

  try {
    let doc;
    let baseKey = null;
    if (body.fromDefault) {
      doc = typeof body.fromDefault === 'string' ? kit().defaultTemplate(body.fromDefault) : null;
      if (!doc) return fail(res, 400, 'Unknown built-in template');
      if (doc.docType !== docType) return fail(res, 400, `That built-in is a ${DOC_LABEL[doc.docType] || doc.docType}`);
      baseKey = body.fromDefault;
    } else if (body.fromTemplateId) {
      if (!isUuid(body.fromTemplateId)) return notFound(res);
      const { rows } = await db.query(q.selectTemplateDraft, [body.fromTemplateId, school]);
      if (rows.length === 0) return notFound(res);
      if (rows[0].doc_type !== docType) return fail(res, 400, `That template is a ${DOC_LABEL[rows[0].doc_type]}`);
      doc = rows[0].draft_doc;
      baseKey = null;
    } else {
      doc = blankDoc(docType);
    }

    const errors = docErrors(doc, docType);
    if (errors.length) return invalid(res, errors);

    const { rows: [created] } = await db.query(q.insertTemplate, [school, docType, named.name, baseKey, doc, userId]);
    logger.info({ actor: userId, school, templateId: created.template_id, docType, baseKey }, 'Report template created');
    return res.status(201).json(toDetail(await loadDetail(created.template_id, school)));
  } catch (err) {
    if (err.code === '23505') return fail(res, 409, DUPLICATE_NAME);
    logger.error({ err }, 'Failed to create report template');
    return fail(res, 500, 'Error creating the template');
  }
};

// GET /api/report-templates/:id
const getTemplate = async (req, res) => {
  try {
    const row = await loadDetail(req.params.id, req.user.school);
    if (!row) return notFound(res);
    return res.status(200).json(toDetail(row));
  } catch (err) {
    logger.error({ err, templateId: req.params.id }, 'Failed to load report template');
    return fail(res, 500, 'Error loading the template');
  }
};

const staleRev = (res, draftRev) => fail(res, 409, 'This template was saved somewhere else since you opened it. Reload to get the latest version.', { draftRev });

// PUT /api/report-templates/:id/draft  { doc, rev }
const saveDraft = async (req, res) => {
  const { school, userId } = req.user;
  const { doc, rev } = req.body ?? {};
  if (!Number.isInteger(rev)) return fail(res, 400, 'rev (the draft revision you loaded) is required');
  try {
    const { rows } = await db.query(q.selectTemplateDraft, [req.params.id, school]);
    if (rows.length === 0) return notFound(res);
    const current = rows[0];
    if (current.draft_rev !== rev) return staleRev(res, current.draft_rev);

    const errors = docErrors(doc, current.doc_type);
    if (errors.length) return invalid(res, errors);

    const { rows: saved } = await db.query(q.updateDraftIfRev, [req.params.id, school, doc, userId, rev]);
    if (saved.length === 0) {
      // Saved by someone else between the read and the write.
      const again = await db.query(q.selectTemplateDraft, [req.params.id, school]);
      if (again.rows.length === 0) return notFound(res);
      return staleRev(res, again.rows[0].draft_rev);
    }
    return res.status(200).json({ draftRev: saved[0].draft_rev });
  } catch (err) {
    logger.error({ err, templateId: req.params.id }, 'Failed to save report template draft');
    return fail(res, 500, 'Error saving the template');
  }
};

// PATCH /api/report-templates/:id  { name }
const renameTemplate = async (req, res) => {
  const { school, userId } = req.user;
  const named = readName((req.body ?? {}).name);
  if (named.error) return fail(res, 400, named.error);
  try {
    const { rows } = await db.query(q.renameTemplate, [req.params.id, school, named.name, userId]);
    if (rows.length === 0) return notFound(res);
    return res.status(200).json(toSummary(await loadSummary(req.params.id, school)));
  } catch (err) {
    if (err.code === '23505') return fail(res, 409, DUPLICATE_NAME);
    logger.error({ err, templateId: req.params.id }, 'Failed to rename report template');
    return fail(res, 500, 'Error renaming the template');
  }
};

const stillAssigned = (res, count) => fail(
  res,
  409,
  count === 1
    ? 'This template is assigned to print for some grades. Remove that assignment first.'
    : `This template is assigned to print in ${count} places. Remove those assignments first.`,
  { code: 'TEMPLATE_ASSIGNED', assignedCount: count },
);

// DELETE /api/report-templates/:id
// Refused while assigned. A template that printed stored reports is archived
// (its versions stay, the reports keep pointing at them); one that never
// printed anything is deleted outright, versions and all.
const deleteTemplate = async (req, res) => {
  const { school, userId } = req.user;
  const templateId = req.params.id;
  try {
    const { rows } = await db.query(q.selectTemplateDraft, [templateId, school]);
    if (rows.length === 0) return notFound(res);

    const { rows: [{ count }] } = await db.query(q.countAssignmentsForTemplate, [templateId]);
    if (count > 0) return stillAssigned(res, count);

    const { rows: [{ used }] } = await db.query(q.templateVersionsUsed, [templateId]);
    if (used) {
      await db.query(q.archiveTemplate, [templateId, school, userId]);
      logger.info({ actor: userId, school, templateId }, 'Report template archived');
      return res.status(200).json({ archived: true });
    }

    await inTransaction(async (client) => {
      await client.query(q.unlinkPublishedVersion, [templateId]);
      await client.query(q.deleteTemplateVersions, [templateId]);
      await client.query(q.deleteTemplate, [templateId, school]);
    });
    logger.info({ actor: userId, school, templateId }, 'Report template deleted');
    return res.status(200).json({ archived: false });
  } catch (err) {
    // An assignment or a printed report appeared since the checks (FK backstop).
    if (err.code === '23503') return fail(res, 409, 'This template is in use. Reload and try again.');
    logger.error({ err, templateId }, 'Failed to delete report template');
    return fail(res, 500, 'Error deleting the template');
  }
};

// POST /api/report-templates/:id/publish  { note? }
// The draft must validate and lay out (the worst-case sample student) before
// it becomes a version. The version is the doc that was checked, even if the
// draft is saved again meanwhile.
const publishTemplate = async (req, res) => {
  const { school, userId } = req.user;
  const templateId = req.params.id;
  const rawNote = (req.body ?? {}).note;
  if (rawNote != null && typeof rawNote !== 'string') return fail(res, 400, 'The note must be text');
  const note = rawNote ? rawNote.trim().slice(0, MAX_NOTE) || null : null;

  let row;
  try {
    const { rows } = await db.query(q.selectTemplateDraft, [templateId, school]);
    row = rows[0];
  } catch (err) {
    logger.error({ err, templateId }, 'Failed to load report template for publishing');
    return fail(res, 500, 'Error publishing the template');
  }
  if (!row) return notFound(res);

  const doc = row.draft_doc;
  const errors = docErrors(doc, row.doc_type);
  if (errors.length) return invalid(res, errors);

  let rendered;
  try {
    rendered = await render.renderReportPdf({ template: doc, data: kit().sampleReportData(PUBLISH_SAMPLE, row.doc_type) });
  } catch (err) {
    logger.warn({ err, templateId }, 'Report template failed its publish render');
    return fail(res, 422, `This template couldn't be printed: ${err.message}`);
  }

  try {
    const version = await inTransaction(async (client) => {
      const { rows: locked } = await client.query(q.lockTemplate, [templateId, school]);
      if (locked.length === 0) return null;
      const { rows: [v] } = await client.query(q.insertVersion, [templateId, doc, sha256(doc), render.engineVersion(), note, userId]);
      await client.query(q.setPublishedVersion, [templateId, v.version_id, userId]);
      return v;
    });
    if (!version) return notFound(res);
    logger.info({ actor: userId, school, templateId, versionNo: version.version_no, pageCount: rendered.pageCount }, 'Report template published');
    return res.status(201).json({
      versionId: version.version_id,
      versionNo: version.version_no,
      publishedAt: version.published_at,
      pageCount: rendered.pageCount,
      warnings: rendered.warnings || [],
    });
  } catch (err) {
    logger.error({ err, templateId }, 'Failed to publish report template');
    return fail(res, 500, 'Error publishing the template');
  }
};

// GET /api/report-templates/:id/versions
const listVersions = async (req, res) => {
  try {
    if (!(await loadSummary(req.params.id, req.user.school))) return notFound(res);
    const { rows } = await db.query(q.listVersions, [req.params.id, req.user.school]);
    return res.status(200).json({ versions: rows.map(toVersion) });
  } catch (err) {
    logger.error({ err, templateId: req.params.id }, 'Failed to list report template versions');
    return fail(res, 500, 'Error loading versions');
  }
};

// POST /api/report-templates/:id/versions/:versionId/restore → draft = that version
const restoreVersion = async (req, res) => {
  const { school, userId } = req.user;
  try {
    const { rows } = await db.query(q.selectVersionDoc, [req.params.versionId, req.params.id, school]);
    if (rows.length === 0) return fail(res, 404, 'Version not found');
    const { rows: [saved] } = await db.query(q.replaceDraft, [req.params.id, school, rows[0].doc, userId]);
    if (!saved) return notFound(res);
    return res.status(200).json({ draftRev: saved.draft_rev, draft: saved.draft_doc });
  } catch (err) {
    logger.error({ err, templateId: req.params.id }, 'Failed to restore report template version');
    return fail(res, 500, 'Error restoring the version');
  }
};

// POST /api/report-templates/:id/discard-draft → draft = the published version
const discardDraft = async (req, res) => {
  const { school, userId } = req.user;
  try {
    const row = await loadDetail(req.params.id, school);
    if (!row) return notFound(res);
    if (!row.published_doc) return fail(res, 400, 'This template has never been published, so there is nothing to go back to');
    const { rows: [saved] } = await db.query(q.replaceDraft, [req.params.id, school, row.published_doc, userId]);
    if (!saved) return notFound(res);
    return res.status(200).json({ draftRev: saved.draft_rev, draft: saved.draft_doc });
  } catch (err) {
    logger.error({ err, templateId: req.params.id }, 'Failed to discard report template draft');
    return fail(res, 500, 'Error discarding the draft');
  }
};

// ────────────────────────────────────────────────────── assignments ──

/**
 * The full assignment from `body`, laid over `base` (an existing row, for
 * PATCH). -> { error, status? } or { docType, templateId, defaultKey, grades, terms, priority }
 */
async function readAssignment(body, base, school) {
  const out = {
    docType: base ? base.doc_type : undefined,
    templateId: base ? base.template_id : null,
    defaultKey: base ? base.default_key : null,
    grades: base ? base.grades : null,
    terms: base ? base.terms : null,
    priority: base ? base.priority : 100,
  };

  if (body.docType !== undefined) out.docType = body.docType;
  if (!DOC_TYPES.includes(out.docType)) return { error: 'Pick a document type: report_card or progress_report' };

  // Naming either target replaces the other.
  if (body.templateId !== undefined || body.defaultKey !== undefined) {
    out.templateId = body.templateId || null;
    out.defaultKey = body.defaultKey || null;
  }
  if (!out.templateId === !out.defaultKey) return { error: 'Assign either one of your templates (templateId) or a built-in (defaultKey)' };

  if (body.grades !== undefined) {
    if (body.grades === null) out.grades = null;
    else if (!Array.isArray(body.grades) || body.grades.length === 0) return { error: 'Pick at least one grade, or null for every grade' };
    else {
      const given = new Set(body.grades.map((g) => String(g).trim().toUpperCase()));
      const unknown = [...given].filter((g) => !GRADES.includes(g));
      if (unknown.length) return { error: `Unknown grade: ${unknown.join(', ')}` };
      out.grades = GRADES.filter((g) => given.has(g));
    }
  }

  if (body.terms !== undefined) {
    if (body.terms === null) out.terms = null;
    else if (!Array.isArray(body.terms) || body.terms.length === 0) return { error: 'Pick at least one term, or null for every term' };
    else {
      const seen = new Map();
      for (const t of body.terms) {
        const read = readTerm(t);
        if (read.error) return { error: read.error };
        if (!seen.has(read.term.toLowerCase())) seen.set(read.term.toLowerCase(), read.term);
      }
      if (seen.size > MAX_TERMS) return { error: `At most ${MAX_TERMS} terms` };
      out.terms = [...seen.values()];
    }
  }

  if (body.priority !== undefined) {
    if (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 10000) {
      return { error: 'Priority is a whole number from 0 to 10000 (lower wins)' };
    }
    out.priority = body.priority;
  }

  if (out.templateId) {
    if (!isUuid(out.templateId)) return { error: 'That template does not exist' };
    const { rows } = await db.query(q.selectAssignableTemplate, [out.templateId, school]);
    if (rows.length === 0) return { error: 'That template does not exist' };
    if (rows[0].doc_type !== out.docType) return { error: `"${rows[0].name}" is a ${DOC_LABEL[rows[0].doc_type]}` };
  } else {
    const def = typeof out.defaultKey === 'string' ? defaultByKey(out.defaultKey) : null;
    if (!def) return { error: 'Unknown built-in template' };
    if (def.docType !== out.docType) return { error: `"${def.name}" is a ${DOC_LABEL[def.docType] || def.docType}` };
  }
  return out;
}

async function loadAssignment(assignmentId, school) {
  const { rows } = await db.query(q.selectAssignment, [assignmentId, school]);
  return rows[0] || null;
}

const assignmentNotFound = (res) => fail(res, 404, 'Assignment not found');

// GET /api/report-templates/assignments?docType=
const listAssignments = async (req, res) => {
  const { docType } = req.query;
  if (docType !== undefined && !DOC_TYPES.includes(docType)) return fail(res, 400, 'Unknown document type');
  try {
    const { rows } = await db.query(q.listAssignments, [req.user.school, docType || null]);
    return res.status(200).json({ assignments: rows.map(toAssignment) });
  } catch (err) {
    logger.error({ err }, 'Failed to list report template assignments');
    return fail(res, 500, 'Error loading assignments');
  }
};

// POST /api/report-templates/assignments  { docType, templateId | defaultKey, grades, terms, priority }
const createAssignment = async (req, res) => {
  const { school, userId } = req.user;
  try {
    const a = await readAssignment(req.body ?? {}, null, school);
    if (a.error) return fail(res, 400, a.error);
    const { rows: [created] } = await db.query(q.insertAssignment, [
      school, a.docType, a.templateId, a.defaultKey, a.grades, a.terms, a.priority, userId,
    ]);
    logger.info({ actor: userId, school, assignmentId: created.assignment_id, ...a }, 'Report template assigned');
    return res.status(201).json(toAssignment(await loadAssignment(created.assignment_id, school)));
  } catch (err) {
    logger.error({ err }, 'Failed to create report template assignment');
    return fail(res, 500, 'Error saving the assignment');
  }
};

// PATCH /api/report-templates/assignments/:assignmentId  (any of the create fields)
const updateAssignment = async (req, res) => {
  const { school, userId } = req.user;
  try {
    const existing = await loadAssignment(req.params.assignmentId, school);
    if (!existing) return assignmentNotFound(res);
    const a = await readAssignment(req.body ?? {}, existing, school);
    if (a.error) return fail(res, 400, a.error);
    const { rows } = await db.query(q.updateAssignment, [
      req.params.assignmentId, school, a.docType, a.templateId, a.defaultKey, a.grades, a.terms, a.priority,
    ]);
    if (rows.length === 0) return assignmentNotFound(res);
    logger.info({ actor: userId, school, assignmentId: req.params.assignmentId, ...a }, 'Report template assignment updated');
    return res.status(200).json(toAssignment(await loadAssignment(req.params.assignmentId, school)));
  } catch (err) {
    logger.error({ err }, 'Failed to update report template assignment');
    return fail(res, 500, 'Error saving the assignment');
  }
};

// DELETE /api/report-templates/assignments/:assignmentId
const deleteAssignment = async (req, res) => {
  const { school, userId } = req.user;
  try {
    const { rows } = await db.query(q.deleteAssignment, [req.params.assignmentId, school]);
    if (rows.length === 0) return assignmentNotFound(res);
    logger.info({ actor: userId, school, assignmentId: req.params.assignmentId }, 'Report template assignment removed');
    return res.status(200).json({ deleted: true });
  } catch (err) {
    logger.error({ err }, 'Failed to delete report template assignment');
    return fail(res, 500, 'Error removing the assignment');
  }
};

// GET /api/report-templates/coverage?docType=
const getCoverage = async (req, res) => {
  const { docType } = req.query;
  if (!DOC_TYPES.includes(docType)) return fail(res, 400, 'Pick a document type: report_card or progress_report');
  try {
    const terms = await schoolTermNames(req);
    const cells = await coverage({ school: req.user.school, docType, terms });
    return res.status(200).json({ terms, grades: [...GRADES], cells, engineMode: engineMode() });
  } catch (err) {
    logger.error({ err }, 'Failed to compute report template coverage');
    return fail(res, 500, 'Error loading coverage');
  }
};

// ────────────────────────────────────────────────────────── previews ──

// GET /api/report-templates/preview/students?grade=&q=
const previewStudents = async (req, res) => {
  const grade = req.query.grade ? String(req.query.grade).trim().toUpperCase() : null;
  if (grade && !GRADES.includes(grade)) return fail(res, 400, 'Unknown grade');
  const text = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const pattern = text ? `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  try {
    const { rows } = await db.query(q.searchStudents, [req.user.school, yearOf(req), grade, pattern]);
    return res.status(200).json({ students: rows.map((r) => ({ studentId: r.student_id, name: r.name, grade: r.grade })) });
  } catch (err) {
    logger.error({ err }, 'Failed to search preview students');
    return fail(res, 500, 'Error loading students');
  }
};

// GET /api/report-templates/preview/data?studentId=&docType=&term=
// The student's ReportData as the engine prints it (images stay signed URLs).
const previewData = async (req, res) => {
  const { studentId, docType } = req.query;
  if (!DOC_TYPES.includes(docType)) return fail(res, 400, 'Pick a document type: report_card or progress_report');
  try {
    const student = await loadSchoolStudent(studentId, req.user.school);
    if (!student) return fail(res, 404, STUDENT_NOT_FOUND);
    let term = req.query.term;
    if (term === undefined || term === '') term = await defaultTerm(req);
    const read = readTerm(term);
    if (read.error) return fail(res, 400, read.error);
    const data = await studentPreviewData({ studentId, docType, term: read.term });
    return res.status(200).json(data);
  } catch (err) {
    if (err instanceof ReportSkip) return fail(res, err.status === 404 ? 404 : 422, err.message);
    logger.error({ err, studentId }, 'Failed to assemble preview report data');
    return fail(res, 500, 'Error loading the report data');
  }
};

// GET /api/report-templates/preview/sample?key=&docType=
// A sample student under the caller's own school name, address and images.
const previewSample = async (req, res) => {
  const { key, docType } = req.query;
  if (!DOC_TYPES.includes(docType)) return fail(res, 400, 'Pick a document type: report_card or progress_report');
  if (!sampleKeys().includes(key)) return fail(res, 400, 'Unknown sample', { samples: sampleKeys() });
  try {
    return res.status(200).json(await sampleWithSchool({ sampleKey: key, docType, school: req.user.school }));
  } catch (err) {
    if (err instanceof ReportSkip) return fail(res, err.status, err.message);
    logger.error({ err }, 'Failed to build sample report data');
    return fail(res, 500, 'Error loading the sample');
  }
};

/** The warnings header: JSON, URI-encoded, kept small enough for proxies. */
function warningsHeader(warnings) {
  const list = (warnings || []).slice(0, MAX_HEADER_WARNINGS).map((w) => ({
    ...w,
    message: typeof w.message === 'string' ? w.message.slice(0, 200) : w.message,
  }));
  return encodeURIComponent(JSON.stringify(list));
}

// POST /api/report-templates/preview/pdf  { doc, docType, studentId?, sample?, term? }
// The server's own print of a draft, for checking it against the editor.
const previewPdf = async (req, res) => {
  const { doc, docType, studentId, sample } = req.body ?? {};
  if (!DOC_TYPES.includes(docType)) return fail(res, 400, 'Pick a document type: report_card or progress_report');
  const errors = docErrors(doc, docType);
  if (errors.length) return invalid(res, errors);

  let data;
  try {
    if (studentId) {
      const student = await loadSchoolStudent(studentId, req.user.school);
      if (!student) return fail(res, 404, STUDENT_NOT_FOUND);
      let term = req.body.term;
      if (term === undefined || term === null || term === '') term = await defaultTerm(req);
      const read = readTerm(term);
      if (read.error) return fail(res, 400, read.error);
      data = await studentPreviewData({ studentId, docType, term: read.term, fields: doc.fields });
    } else {
      const key = sample || DEFAULT_SAMPLE;
      if (!sampleKeys().includes(key)) return fail(res, 400, 'Unknown sample', { samples: sampleKeys() });
      data = await sampleWithSchool({ sampleKey: key, docType, school: req.user.school });
      data.extra = { ...(data.extra || {}), ...mergeExtras(doc.fields, {}) };
    }
    data = await render.inlineAssets(data);
  } catch (err) {
    if (err instanceof ReportSkip) return fail(res, [400, 404].includes(err.status) ? err.status : 422, err.message);
    logger.error({ err, studentId }, 'Failed to prepare a report preview');
    return fail(res, 500, 'Error preparing the preview');
  }

  try {
    const { pdf, pageCount, warnings } = await render.renderReportPdf({ template: doc, data });
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="report-preview.pdf"',
      'Cache-Control': 'no-store',
      'X-Report-Pages': String(pageCount ?? ''),
      'X-Report-Warnings': warningsHeader(warnings),
    });
    return res.status(200).send(pdf);
  } catch (err) {
    logger.warn({ err }, 'Report preview render failed');
    return fail(res, 422, `This template couldn't be printed: ${err.message}`);
  }
};

// ───────────────────────────────────────────────────── field values ──

// GET /api/report-templates/field-values?docType=&term=&grade=
// The extra fields of the template that prints (docType, grade, term), and
// what's filled in for each current student of the grade.
const getFieldValues = async (req, res) => {
  const { docType } = req.query;
  if (!DOC_TYPES.includes(docType)) return fail(res, 400, 'Pick a document type: report_card or progress_report');
  const read = readTerm(req.query.term);
  if (read.error) return fail(res, 400, read.error);
  const grade = req.query.grade ? String(req.query.grade).trim().toUpperCase() : '';
  if (!GRADES.includes(grade)) return fail(res, 400, 'Pick a grade');
  const { school } = req.user;
  try {
    const resolved = await resolveTemplate({ school, docType, grade, term: read.term });
    const { rows: students } = await db.query(q.selectStudentsInGrade, [school, yearOf(req), grade]);
    const values = new Map(students.map((s) => [s.student_id, {}]));
    if (students.length > 0) {
      const { rows } = await db.query(q.selectFieldValuesForStudents, [students.map((s) => s.student_id), docType, read.term]);
      for (const r of rows) if (values.has(r.student_id) && !isBlank(r.value)) values.get(r.student_id)[r.field_key] = r.value;
    }
    return res.status(200).json({
      template: resolved
        ? { source: resolved.source, name: resolved.name, templateId: resolved.templateId, versionId: resolved.versionId, defaultKey: resolved.defaultKey }
        : null,
      fields: (resolved && resolved.doc.fields) || [],
      students: students.map((s) => ({ studentId: s.student_id, name: s.name, values: values.get(s.student_id) })),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load report field values');
    return fail(res, 500, 'Error loading the fields');
  }
};

/** One submitted value → the text to store ('' = clear), or { error }. */
function readFieldValue(field, raw) {
  if (raw === null || raw === undefined) return { value: '' };
  if (typeof raw === 'boolean' || typeof raw === 'number') raw = String(raw);
  if (typeof raw !== 'string') return { error: `"${field.label || field.key}" must be text` };
  if (raw.length > MAX_VALUE) return { error: `"${field.label || field.key}" is too long` };
  const value = raw.trim() === '' ? '' : raw;
  if (value && field.type === 'select' && Array.isArray(field.options) && field.options.length && !field.options.includes(value)) {
    return { error: `"${value}" isn't one of the choices for "${field.label || field.key}"` };
  }
  return { value };
}

// PUT /api/report-templates/field-values  { docType, term, studentId, values: { key: string|null } }
// Only the keys of the template that prints this student's report; an empty
// value clears the field.
const putFieldValues = async (req, res) => {
  const { school, userId } = req.user;
  const body = req.body ?? {};
  const { docType, studentId, values } = body;
  if (!DOC_TYPES.includes(docType)) return fail(res, 400, 'Pick a document type: report_card or progress_report');
  const read = readTerm(body.term);
  if (read.error) return fail(res, 400, read.error);
  if (!values || typeof values !== 'object' || Array.isArray(values)) return fail(res, 400, 'values must be an object of field keys');

  try {
    const student = await loadSchoolStudent(studentId, school);
    if (!student) return fail(res, 404, STUDENT_NOT_FOUND);

    const resolved = await resolveTemplate({ school, docType, grade: student.grade, term: read.term });
    const fields = new Map(((resolved && resolved.doc.fields) || []).map((f) => [f.key, f]));
    const unknown = Object.keys(values).filter((k) => !fields.has(k));
    if (unknown.length) {
      return fail(res, 400, resolved
        ? `The template that prints this report has no field ${unknown.map((k) => `"${k}"`).join(', ')}`
        : 'No template prints this report yet, so it has no extra fields', { unknown });
    }

    const writes = [];
    for (const [key, raw] of Object.entries(values)) {
      const v = readFieldValue(fields.get(key), raw);
      if (v.error) return fail(res, 400, v.error);
      writes.push([key, v.value]);
    }

    await inTransaction(async (client) => {
      for (const [key, value] of writes) {
        if (value === '') await client.query(q.deleteFieldValue, [studentId, docType, read.term, key]);
        else await client.query(q.upsertFieldValue, [school, studentId, docType, read.term, key, value, userId]);
      }
    });
    return res.status(200).json({ values: await loadFieldValues({ studentId, docType, term: read.term }) });
  } catch (err) {
    logger.error({ err, studentId }, 'Failed to save report field values');
    return fail(res, 500, 'Error saving the fields');
  }
};

module.exports = {
  listTemplates,
  createTemplate,
  getTemplate,
  saveDraft,
  renameTemplate,
  deleteTemplate,
  publishTemplate,
  listVersions,
  restoreVersion,
  discardDraft,
  listAssignments,
  createAssignment,
  updateAssignment,
  deleteAssignment,
  getCoverage,
  previewStudents,
  previewData,
  previewSample,
  previewPdf,
  getFieldValues,
  putFieldValues,
  // exported for unit tests
  stableStringify,
  blankDoc,
};
