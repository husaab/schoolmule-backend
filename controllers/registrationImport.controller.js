// controllers/registrationImport.controller.js
//
// HTTP surface for importing registration form submissions as students:
// the saved field mapping, the preview/execute pair, and undo.

const db = require('../config/database');
const logger = require('../logger');
const registrationQueries = require('../queries/registration.queries');
const importQueries = require('../queries/registrationImport.queries');
const target = require('../services/import/studentImportTarget');
const engine = require('../services/import/engine');

const VALID_TARGETS = new Set(target.mappableFields.map(f => f.targetField));

// Confirms the form exists and belongs to the caller's school. Every handler
// starts here, so a form UUID from another tenant is a 404, not a leak.
async function loadForm(formId, school) {
  const { rows } = await db.query(registrationQueries.selectFormById, [formId, school]);
  return rows[0] || null;
}

function toCamelMapping(row) {
  return {
    mappingId: row.mapping_id,
    fieldId: row.field_id,
    targetField: row.target_field,
    valueMap: row.value_map || null,
  };
}

// ─── Mapping ──────────────────────────────────────────────────────────

/**
 * The form's saved mapping, or — when none has been saved yet — a suggestion
 * derived from the field labels. `isSuggested` tells the UI to present it as a
 * proposal the admin still has to confirm.
 *
 * Suggestion lives here rather than in the frontend so preview, execute and the
 * editor all agree on what an unconfigured form maps to.
 */
const getMapping = async (req, res) => {
  try {
    const { formId } = req.params;
    const school = req.user.school;

    const form = await loadForm(formId, school);
    if (!form) return res.status(404).json({ status: 'failed', message: 'Form not found' });

    const { rows: fields } = await db.query(registrationQueries.selectFieldsByFormId, [formId]);
    const { rows: saved } = await db.query(importQueries.selectMappingsByForm, [formId, school]);

    const isSuggested = saved.length === 0;
    const mappings = isSuggested
      ? target.suggestMapping(fields).map(m => ({
          mapping_id: null, field_id: m.fieldId, target_field: m.targetField, value_map: m.valueMap,
        }))
      : saved;

    return res.status(200).json({
      status: 'success',
      data: {
        isSuggested,
        mappings: mappings.map(toCamelMapping),
        // The catalogue of what a form field can map to, so the editor doesn't
        // hardcode a list that could drift from the backend's validation.
        targetFields: target.mappableFields.map(f => ({
          targetField: f.targetField,
          label: f.label,
          dataType: f.dataType,
          group: f.group,
          required: f.required,
          enumValues: f.enumValues || null,
        })),
        fields: fields.map(f => ({
          fieldId: f.field_id,
          fieldType: f.field_type,
          label: f.label,
          options: f.options,
          sortOrder: f.sort_order,
        })),
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error loading import mapping');
    return res.status(500).json({ status: 'failed', message: 'Error loading import mapping' });
  }
};

/**
 * Replace the form's whole mapping in one transaction — the same
 * full-array-replace shape used for saving the form's fields.
 */
const saveMapping = async (req, res) => {
  const { formId } = req.params;
  const school = req.user.school;
  const { mappings } = req.body;

  if (!Array.isArray(mappings)) {
    return res.status(400).json({ status: 'failed', message: 'mappings must be an array' });
  }

  const form = await loadForm(formId, school);
  if (!form) return res.status(404).json({ status: 'failed', message: 'Form not found' });

  const { rows: fields } = await db.query(registrationQueries.selectFieldsByFormId, [formId]);
  const fieldById = new Map(fields.map(f => [f.field_id, f]));

  // Validate the whole set before writing any of it, so a bad row can't leave
  // a half-saved mapping behind.
  const seenTargets = new Set();
  const seenFields = new Set();
  for (const m of mappings) {
    if (!m || !fieldById.has(m.fieldId)) {
      return res.status(400).json({ status: 'failed', message: 'Mapping references a field that is not on this form' });
    }
    if (!VALID_TARGETS.has(m.targetField)) {
      return res.status(400).json({ status: 'failed', message: `Unknown target field "${m.targetField}"` });
    }
    if (seenFields.has(m.fieldId)) {
      return res.status(400).json({ status: 'failed', message: 'A form field can only map to one student field' });
    }
    if (seenTargets.has(m.targetField)) {
      return res.status(400).json({ status: 'failed', message: `Two form fields both map to "${m.targetField}"` });
    }
    seenFields.add(m.fieldId);
    seenTargets.add(m.targetField);
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(importQueries.deleteMappingsByForm, [formId]);
    for (const m of mappings) {
      await client.query(importQueries.upsertMapping, [
        formId, m.fieldId, m.targetField, m.valueMap ? JSON.stringify(m.valueMap) : null,
      ]);
    }
    await client.query('COMMIT');

    const { rows: saved } = await db.query(importQueries.selectMappingsByForm, [formId, school]);
    return res.status(200).json({
      status: 'success',
      data: { isSuggested: false, mappings: saved.map(toCamelMapping) },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({ err: error }, 'Error saving import mapping');
    return res.status(500).json({ status: 'failed', message: 'Error saving import mapping' });
  } finally {
    client.release();
  }
};

// ─── Preview / execute ────────────────────────────────────────────────

// Normalizes the request body's scope into the shape the engine expects.
// Anything that isn't an explicit id selection is treated as filter mode.
function parseScope(body) {
  const scope = body?.scope || {};
  if (scope.mode === 'selected') {
    return { mode: 'selected', submissionIds: Array.isArray(scope.submissionIds) ? scope.submissionIds : [] };
  }
  return {
    mode: 'filtered',
    status: scope.status || null,
    dateFrom: scope.dateFrom || null,
    dateTo: scope.dateTo || null,
    fieldFilters: Array.isArray(scope.fieldFilters) ? scope.fieldFilters : [],
    importState: scope.importState === 'imported' || scope.importState === 'not_imported' ? scope.importState : null,
    sorts: Array.isArray(scope.sorts) ? scope.sorts : [],
  };
}

function parseOverrides(body) {
  const raw = body?.overrides && typeof body.overrides === 'object' ? body.overrides : {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === 'create' || v === 'update' || v === 'skip') out[k] = v;
  }
  return out;
}

function parseOverrideMatchIds(body) {
  const raw = body?.overrideMatchIds && typeof body.overrideMatchIds === 'object' ? body.overrideMatchIds : {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

const previewImport = async (req, res) => {
  try {
    const { formId } = req.params;
    const school = req.user.school;
    const schoolYearId = req.schoolYear?.schoolYearId || null;

    const form = await loadForm(formId, school);
    if (!form) return res.status(404).json({ status: 'failed', message: 'Form not found' });
    if (!schoolYearId) {
      return res.status(400).json({ status: 'failed', message: 'No school year configured for your school' });
    }

    const result = await engine.runPreview(db, {
      formId,
      school,
      schoolYearId,
      scope: parseScope(req.body),
      overrides: parseOverrides(req.body),
      overrideMatchIds: parseOverrideMatchIds(req.body),
      target,
    });

    return res.status(200).json({ status: 'success', data: result });
  } catch (error) {
    logger.error({ err: error }, 'Error previewing import');
    return res.status(500).json({ status: 'failed', message: 'Error previewing import' });
  }
};

const executeImport = async (req, res) => {
  try {
    const { formId } = req.params;
    const school = req.user.school;
    const schoolYearId = req.schoolYear?.schoolYearId || null;

    const form = await loadForm(formId, school);
    if (!form) return res.status(404).json({ status: 'failed', message: 'Form not found' });
    if (!schoolYearId) {
      return res.status(400).json({ status: 'failed', message: 'No school year configured for your school' });
    }

    const sideEffects = req.body?.sideEffects || {};
    const result = await engine.runExecute(db, {
      formId,
      school,
      schoolYearId,
      userId: req.user.userId || req.user.user_id || null,
      scope: parseScope(req.body),
      overrides: parseOverrides(req.body),
      overrideMatchIds: parseOverrideMatchIds(req.body),
      sideEffects: {
        homeroomTeacherId: sideEffects.homeroomTeacherId || null,
        autoEnroll: sideEffects.autoEnroll === true,
      },
      target,
    });

    if (!result.ok) {
      return res.status(400).json({ status: 'failed', message: result.message, code: result.code });
    }

    logger.info(
      { formId, school, created: result.summary.created, updated: result.summary.updated },
      'Registration submissions imported as students',
    );
    return res.status(200).json({ status: 'success', data: result });
  } catch (error) {
    logger.error({ err: error }, 'Error executing import');
    return res.status(500).json({ status: 'failed', message: 'Error importing submissions' });
  }
};

// ─── Undo ─────────────────────────────────────────────────────────────

// What undoing this import would do — lets the dialog offer "delete the
// student too" only when that is actually safe.
const getUndoInfo = async (req, res) => {
  try {
    const result = await engine.inspectUndo(db, {
      submissionId: req.params.submissionId,
      school: req.user.school,
      target,
    });
    if (!result.ok) {
      const code = result.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(code).json({ status: 'failed', message: result.message });
    }
    return res.status(200).json({ status: 'success', data: result });
  } catch (error) {
    logger.error({ err: error }, 'Error inspecting import undo');
    return res.status(500).json({ status: 'failed', message: 'Error inspecting import' });
  }
};

const undoImport = async (req, res) => {
  try {
    const result = await engine.runUndo(db, {
      submissionId: req.params.submissionId,
      school: req.user.school,
      deleteStudent: req.body?.deleteStudent === true,
      target,
    });
    if (!result.ok) {
      const code = result.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(code).json({ status: 'failed', message: result.message });
    }

    const message = result.studentDeleted
      ? 'Import undone and student deleted'
      : result.blockedBy.length > 0
        ? 'Import undone. The student was kept because other records depend on it.'
        : 'Import undone';

    return res.status(200).json({ status: 'success', message, data: result });
  } catch (error) {
    logger.error({ err: error }, 'Error undoing import');
    return res.status(500).json({ status: 'failed', message: 'Error undoing import' });
  }
};

module.exports = {
  getMapping,
  saveMapping,
  previewImport,
  executeImport,
  getUndoInfo,
  undoImport,
};
