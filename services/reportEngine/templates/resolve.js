// services/reportEngine/templates/resolve.js
//
// Which template prints a student's report: the school's assignments first,
// then the engine's built-in default for the grade, else nothing (null) and
// the caller prints with the legacy generator.
//
//   1. Assignments of (school, docType) whose grades include the grade (NULL
//      = every grade) and whose terms include the term (NULL = every term;
//      names compared case-insensitively). Best first: lower priority, then
//      the more specific (grades set, then terms set), then the newest.
//      An assignment to a designed template prints its PUBLISHED version and
//      is passed over while it has none or the template is archived; an
//      assignment to a built-in key is passed over when that key isn't in
//      this engine bundle (or is the other document type).
//   2. The first DEFAULT_TEMPLATES entry of the docType listing the grade.
//   3. null.
//
// The built-in list is read from the bundle at runtime: never assume which
// defaults exist.

const db = require('../../../config/database');
const q = require('../../../queries/reportTemplates.queries');
const { reportKit } = require('../render');
const { gradeText } = require('../data/format');

const GRADES = Object.freeze(['JK', 'SK', '1', '2', '3', '4', '5', '6', '7', '8']);
const LEGACY_NAME = 'Legacy layout';

const termKey = (term) => String(term ?? '').trim().toLowerCase();
const time = (v) => (v ? new Date(v).getTime() || 0 : 0);

function defaults() {
  return reportKit().DEFAULT_TEMPLATES || [];
}

/** The built-in default with this key, or null. */
function defaultByKey(key) {
  return defaults().find((t) => t.key === key) || null;
}

/** The built-in that prints (docType, grade) when no assignment does, or null. */
function defaultFor(docType, grade) {
  const g = gradeText(grade);
  return defaults().find((t) => t.docType === docType && Array.isArray(t.grades) && t.grades.includes(g)) || null;
}

function appliesTo(a, grade, term) {
  if (Array.isArray(a.grades) && !a.grades.map(gradeText).includes(grade)) return false;
  if (Array.isArray(a.terms) && !a.terms.some((t) => termKey(t) === term)) return false;
  return true;
}

/** Best first: priority, then specificity, then the newest. */
function compareAssignments(a, b) {
  const pa = Number(a.priority ?? 100);
  const pb = Number(b.priority ?? 100);
  if (pa !== pb) return pa - pb;
  const ga = Array.isArray(a.grades) ? 0 : 1;
  const gb = Array.isArray(b.grades) ? 0 : 1;
  if (ga !== gb) return ga - gb;
  const ta = Array.isArray(a.terms) ? 0 : 1;
  const tb = Array.isArray(b.terms) ? 0 : 1;
  if (ta !== tb) return ta - tb;
  return time(b.created_at) - time(a.created_at);
}

/**
 * What an assignment row prints, or null when it can't print right now.
 * Row shape: queries/reportTemplates.queries.js listAssignments.
 */
function targetOf(a, docType) {
  if (a.template_id) {
    if (!a.published_version_id || a.template_archived_at) return null;
    return {
      source: 'assignment',
      templateId: a.template_id,
      versionId: a.published_version_id,
      defaultKey: null,
      name: a.template_name,
      assignmentId: a.assignment_id,
    };
  }
  const def = defaultByKey(a.default_key);
  if (!def || def.docType !== docType) return null;
  return {
    source: 'assignment',
    templateId: null,
    versionId: null,
    defaultKey: def.key,
    name: def.name,
    assignmentId: a.assignment_id,
  };
}

/**
 * Pure: the winner for one (docType, grade, term) among a school's
 * assignment rows, without its doc. null = legacy.
 */
function pickTarget(assignments, { docType, grade, term }) {
  const g = gradeText(grade);
  const t = termKey(term);
  const candidates = (assignments || [])
    .filter((a) => a.doc_type === docType && appliesTo(a, g, t))
    .sort(compareAssignments);
  for (const a of candidates) {
    const target = targetOf(a, docType);
    if (target) return target;
  }
  const def = defaultFor(docType, g);
  if (!def) return null;
  return { source: 'default', templateId: null, versionId: null, defaultKey: def.key, name: def.name, assignmentId: null };
}

/**
 * The template that prints this report.
 * @returns {Promise<null | { doc, source: 'assignment'|'default', templateId, versionId, defaultKey, name, assignmentId }>}
 */
async function resolveTemplate({ school, docType, grade, term, client = db }) {
  const { rows } = await client.query(q.listAssignments, [school, docType]);
  const target = pickTarget(rows, { docType, grade, term });
  if (!target) return null;
  let doc;
  if (target.versionId) {
    const { rows: versions } = await client.query(q.selectPublishedDoc, [target.versionId]);
    // A published version can't be deleted while its template is assigned.
    if (versions.length === 0) throw new Error(`Published version ${target.versionId} is missing`);
    doc = versions[0].doc;
  } else {
    doc = reportKit().defaultTemplate(target.defaultKey);
  }
  return { doc, ...target };
}

/**
 * The print plan of one document type: for every grade × term, what prints.
 * @returns {Promise<Array<{ grade, term, source: 'assignment'|'default'|'legacy', name, templateId, versionId, defaultKey, assignmentId }>>}
 */
async function coverage({ school, docType, terms, client = db }) {
  const { rows } = await client.query(q.listAssignments, [school, docType]);
  const cells = [];
  for (const grade of GRADES) {
    for (const term of terms || []) {
      const target = pickTarget(rows, { docType, grade, term });
      cells.push(target
        ? { grade, term, ...target }
        : { grade, term, source: 'legacy', name: LEGACY_NAME, templateId: null, versionId: null, defaultKey: null, assignmentId: null });
    }
  }
  return cells;
}

module.exports = {
  GRADES,
  LEGACY_NAME,
  resolveTemplate,
  coverage,
  pickTarget,
  targetOf,
  compareAssignments,
  defaultByKey,
  defaultFor,
};
