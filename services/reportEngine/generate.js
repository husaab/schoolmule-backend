// services/reportEngine/generate.js
//
// Printing a stored report (report card / progress report) through the
// report engine instead of a legacy HTML template, behind REPORT_ENGINE:
//
//   legacy (default, also any unknown value)  the legacy generators only
//   new     the engine prints whenever a template resolves for the student's
//           grade and term (templates/resolve.js); with none, or if the
//           engine fails (logged), the legacy generator prints instead
//   shadow  the legacy generator prints and uploads as today; the engine
//           also lays the report out, uploads nothing and logs the result
//
// The engine writes to the same bucket, path and row the legacy generator
// would, so report emails, parent access and deletes keep working. The six
// legacy entry points call withReportEngine (see the comments marked
// "Report engine" in controllers/reportCard, progressReports, jk and sk).

const db = require('../../config/database');
const supabase = require('../../config/supabaseClient');
const logger = require('../../logger');
const studentQueries = require('../../queries/student.queries');
const q = require('../../queries/reportTemplates.queries');
const { assembleReportData } = require('./data');
const { ReportSkip } = require('./data/errors');
const { gradeText } = require('./data/format');
const render = require('./render');
const { resolveTemplate } = require('./templates/resolve');
const { loadFieldValues, mergeExtras, missingRequired } = require('./fields');

const MODES = new Set(['legacy', 'new', 'shadow']);
const BUCKETS = { report_card: 'report-cards', progress_report: 'progress-reports' };
const KINDERGARTEN = new Set(['JK', 'SK']);

// Set on the opts a wrapper hands its legacy generator, so a legacy path that
// routes on to another wrapped generator (generateSingleReportCard → the JK
// report card) doesn't run the engine a second time.
const ENGINE_HANDLED = Symbol('reportEngineHandled');

/** REPORT_ENGINE, read per call so a deploy can flip it without code. */
function engineMode() {
  const mode = String(process.env.REPORT_ENGINE || 'legacy').trim().toLowerCase();
  return MODES.has(mode) ? mode : 'legacy';
}

/**
 * The legacy generators' storage path for a student's report, exactly:
 *   report card 1-8   reportCard.controller.js generateSingleReportCard /
 *                     generateAlHaadiT2ReportCard (name and term as typed)
 *   report card JK/SK jk/sk.controller.js generateSingle{JK,SK}ReportCard
 *   progress 1-8      progressReports.controller.js generateSingleProgressReport
 *   progress JK/SK    jk/sk.controller.js generateSingle{JK,SK}ProgressReport
 */
function reportFilePath({ docType, school, studentName, grade, term }) {
  const folder = String(school).replace(/\s+/g, '').toUpperCase();
  const name = String(studentName);
  const t = String(term);
  const u = (s) => s.replace(/\s+/g, '_');
  const g = gradeText(grade);
  if (docType === 'report_card') {
    if (g === 'JK') return `${folder}/${u(name)}_${u(t)}_jk_report_card.pdf`;
    if (g === 'SK') return `${folder}/${u(name)}_${u(t)}_sk_report_card.pdf`;
    return `${folder}/${name}_${t}_report_card.pdf`;
  }
  if (g === 'JK') return `${folder}/${u(name)}_${u(t)}_jk_progress_report.pdf`;
  if (g === 'SK') return `${folder}/${u(name)}_${u(t)}_sk_progress_report.pdf`;
  return `${folder}/${u(name)}_${u(t)}_progress_report.pdf`;
}

const engineContext = (resolved) => (resolved
  ? { source: resolved.source, templateId: resolved.templateId, versionId: resolved.versionId, defaultKey: resolved.defaultKey }
  : {});

/**
 * Everything the engine needs to print one report, or null when no template
 * resolves (or the student doesn't exist: the legacy generator then answers
 * "Student not found" in its own way).
 * @throws {ReportSkip} the assembler's skips, and a required extra field left empty (422)
 */
async function prepareEngineReport({ studentId, docType, term, reportDate = null, client = db }) {
  const { rows } = await client.query(studentQueries.selectStudentById, [studentId]);
  if (rows.length === 0) return null;
  const student = rows[0];

  const resolved = await resolveTemplate({ school: student.school, docType, grade: student.grade, term, client });
  if (!resolved) return null;

  try {
    const data = await assembleReportData({ studentId, docType, term, reportDate, client });
    const stored = await loadFieldValues({ studentId, docType, term, client });
    const fields = resolved.doc.fields || [];
    data.extra = { ...(data.extra || {}), ...mergeExtras(fields, stored) };

    const missing = missingRequired(fields, data.extra);
    if (missing.length > 0) {
      throw new ReportSkip(`Fill in ${missing.map((f) => f.label || f.key).join(', ')} for ${student.name} first`, 422);
    }
    return { student, resolved, data };
  } catch (err) {
    if (!(err instanceof ReportSkip)) err.reportEngine = engineContext(resolved);
    throw err;
  }
}

/**
 * Print, upload and record one student's report with the engine.
 * @returns {Promise<null | { studentId, studentName, term, filePath, grade, record, pageCount, warnings, source, templateId, versionId, defaultKey }>}
 *          null when no template resolves: the caller prints with the legacy generator.
 * @throws {ReportSkip} see prepareEngineReport; anything else is an engine failure
 */
async function generateWithEngine({ studentId, docType, term, reportDate = null, browser = null }) {
  const prep = await prepareEngineReport({ studentId, docType, term, reportDate });
  if (!prep) return null;
  const { student, resolved, data } = prep;

  try {
    const inlined = await render.inlineAssets(data);
    const { pdf, pageCount, warnings, engineVersion } = await render.renderReportPdf({ template: resolved.doc, data: inlined, browser });

    const grade = gradeText(student.grade);
    const filePath = reportFilePath({ docType, school: student.school, studentName: student.name, grade, term });
    const { error } = await supabase.storage
      .from(BUCKETS[docType])
      .upload(filePath, pdf, { contentType: 'application/pdf', upsert: true });
    if (error) throw new Error('Upload to storage failed');

    // template_key: the built-in that printed it (NULL for a designed template,
    // whose version id says which it was).
    const provenance = [resolved.versionId, resolved.defaultKey, engineVersion ?? null, JSON.stringify(warnings || [])];
    let record = null;
    if (docType === 'report_card') {
      await db.query(q.upsertEngineReportCard, [studentId, term, student.name, filePath, student.grade, student.school, ...provenance]);
    } else {
      const { rows } = await db.query(q.upsertEngineProgressReport, [studentId, term, student.name, student.grade, filePath, student.school, ...provenance]);
      record = rows[0] || null;
    }

    logger.info(
      { studentId, docType, term, ...engineContext(resolved), pageCount, warnings: (warnings || []).length },
      'Report printed by the report engine',
    );
    return {
      studentId,
      studentName: student.name,
      term,
      filePath,
      grade,
      record,
      pageCount,
      warnings: warnings || [],
      ...engineContext(resolved),
    };
  } catch (err) {
    err.reportEngine = engineContext(resolved);
    throw err;
  }
}

/** Lay the report out with the engine, upload nothing, log what happened. Never throws. */
async function shadowRender({ studentId, docType, term, reportDate = null, engine = null }) {
  const started = Date.now();
  let prep = null;
  try {
    prep = await prepareEngineReport({ studentId, docType, term, reportDate });
    if (!prep) {
      logger.info({ studentId, docType, term }, 'Report engine shadow: no template, legacy only');
      return;
    }
    const browser = engine ? await engine.browser() : null;
    const inlined = await render.inlineAssets(prep.data);
    const { pageCount, warnings } = await render.renderReportPdf({ template: prep.resolved.doc, data: inlined, browser });
    logger.info(
      { studentId, docType, term, ...engineContext(prep.resolved), pageCount, warnings: warnings || [], ms: Date.now() - started },
      'Report engine shadow render',
    );
  } catch (err) {
    if (err instanceof ReportSkip) {
      logger.info({ studentId, docType, term, reason: err.message }, 'Report engine shadow: would skip');
    } else {
      logger.warn({ err, studentId, docType, term, ...(err.reportEngine || engineContext(prep && prep.resolved)) }, 'Report engine shadow render failed');
    }
  }
}

/** The legacy generator printed this row: drop provenance an earlier engine run left. */
async function forgetEngineProvenance(docType, studentId, term) {
  try {
    await db.query(docType === 'report_card' ? q.clearEngineReportCard : q.clearEngineProgressReport, [studentId, term]);
  } catch (err) {
    logger.warn({ err, studentId, docType, term }, 'Could not clear report engine provenance');
  }
}

/**
 * Run one legacy entry point under REPORT_ENGINE.
 * @param {object}   args
 * @param {'report_card'|'progress_report'} args.docType
 * @param {string}   args.studentId
 * @param {string}   args.term
 * @param {object}   [args.opts]   the generator's opts ({ browser, engine })
 * @param {Function} [args.shape]  engine result → the legacy generator's return value
 * @param {Function} legacy       (opts) => the legacy generator's promise
 */
async function withReportEngine({ docType, studentId, term, opts = {}, shape = (r) => r }, legacy) {
  const mode = engineMode();
  if (mode === 'legacy' || opts[ENGINE_HANDLED]) return legacy(opts);
  const inner = { ...opts, [ENGINE_HANDLED]: true };

  if (mode === 'shadow') {
    const out = await legacy(inner);
    await forgetEngineProvenance(docType, studentId, term);
    await shadowRender({ studentId, docType, term, reportDate: opts.reportDate || null, engine: opts.engine || null });
    return out;
  }

  let result = null;
  try {
    const browser = opts.engine ? await opts.engine.browser() : null;
    result = await generateWithEngine({ studentId, docType, term, reportDate: opts.reportDate || null, browser });
  } catch (err) {
    if (err instanceof ReportSkip) throw err;
    // A report still prints: the legacy generator takes over.
    logger.error({ err, studentId, docType, term, ...(err.reportEngine || {}) }, 'Report engine failed; printing with the legacy generator');
    result = null;
  }
  if (result) return shape(result);

  const out = await legacy(inner);
  await forgetEngineProvenance(docType, studentId, term);
  return out;
}

/**
 * One engine browser for a bulk run, launched on first use (never under
 * REPORT_ENGINE=legacy). Pass as opts.engine; close() in the run's finally.
 */
function reportEngineSession() {
  let pending = null;
  return {
    browser() {
      if (engineMode() === 'legacy') return Promise.resolve(null);
      if (!pending) pending = render.launchReportBrowser();
      return pending;
    },
    async close() {
      if (!pending) return;
      const launching = pending;
      pending = null;
      try {
        // A launch that failed was already logged by each report that fell back.
        const browser = await launching.catch(() => null);
        if (browser) await browser.close();
      } catch (err) {
        logger.warn({ err }, 'Failed to close the report engine browser');
      }
    },
  };
}

// ── the legacy generators' return values, for withReportEngine's `shape` ──

/** jk/sk.controller.js generateSingle{JK,SK}{ProgressReport,ReportCard}. */
const kindergartenResult = (r) => ({ studentId: r.studentId, studentName: r.studentName, term: r.term, filePath: r.filePath });

/** reportCard.controller.js generateSingleReportCard: a message for grades 1-8, the JK/SK generator's object otherwise. */
const reportCardResult = (r) => (KINDERGARTEN.has(r.grade) ? kindergartenResult(r) : 'Report card generated and uploaded');

/** progressReports.controller.js generateSingleProgressReport: grades 1-8 add the saved row as recordId. */
const progressReportResult = (r) => (KINDERGARTEN.has(r.grade) ? kindergartenResult(r) : { ...kindergartenResult(r), recordId: r.record });

module.exports = {
  engineMode,
  reportFilePath,
  prepareEngineReport,
  generateWithEngine,
  shadowRender,
  withReportEngine,
  reportEngineSession,
  kindergartenResult,
  reportCardResult,
  progressReportResult,
  ENGINE_HANDLED,
  BUCKETS,
};
