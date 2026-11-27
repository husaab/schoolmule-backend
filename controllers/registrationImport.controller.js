const { parsePaymentState } = require('../services/submissionFilters');
// controllers/registrationImport.controller.js
//
// HTTP surface for importing registration form submissions as students:
// the saved field mapping, the preview/execute pair, and undo.

const db = require('../config/database');
const logger = require('../logger');
const registrationQueries = require('../queries/registration.queries');
const importQueries = require('../queries/registrationImport.queries');
const customFieldQueries = require('../queries/studentCustomFields.queries');
const target = require('../services/import/studentImportTarget');
const engine = require('../services/import/engine');
const { can } = require('../services/access/access');
const { loadLiveFields, fieldsById, toField } = require('../services/customFields/fields');
const { validateNewField, LIMITS, UUID_RE } = require('../services/customFields/values');

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
    // Set when targetField is 'custom': which of the school's fields the question feeds.
    customFieldId: row.custom_field_id || null,
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
    const customFields = await loadLiveFields(db, school);

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
        // The school's custom fields: a question with no built-in student
        // field can be saved into one of these, or into a new one.
        customFields,
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
  const liveFields = await loadLiveFields(db, school);
  const liveById = fieldsById(liveFields);
  const liveByLabel = new Map(liveFields.map(f => [f.label.toLowerCase(), f]));

  const seenTargets = new Set();
  const seenFields = new Set();
  const seenCustom = new Set();
  const seenNewLabels = new Set();
  // What will be written, one entry per mapping: { fieldId, targetField, valueMap, customFieldId | newField }
  const plan = [];

  for (const m of mappings) {
    if (!m || !fieldById.has(m.fieldId)) {
      return res.status(400).json({ status: 'failed', message: 'Mapping references a field that is not on this form' });
    }
    if (seenFields.has(m.fieldId)) {
      return res.status(400).json({ status: 'failed', message: 'A form field can only map to one student field' });
    }
    seenFields.add(m.fieldId);
    const valueMap = m.valueMap && typeof m.valueMap === 'object' && Object.keys(m.valueMap).length > 0 ? m.valueMap : null;

    if (m.targetField === target.CUSTOM_TARGET) {
      // A custom field: one of the school's existing fields, or a new one
      // created from this question.
      const existingId = typeof m.customFieldId === 'string' && UUID_RE.test(m.customFieldId)
        ? m.customFieldId.toLowerCase() : null;
      const wantsNew = m.newField !== undefined && m.newField !== null;
      if (Boolean(existingId) === wantsNew) {
        return res.status(400).json({ status: 'failed', message: 'A custom field mapping needs an existing field or a new one' });
      }

      let field = existingId ? liveById.get(existingId) : null;
      let newField = null;
      if (existingId && !field) {
        return res.status(400).json({ status: 'failed', message: 'One of the custom fields no longer exists. Reload and try again.' });
      }
      if (wantsNew) {
        const checked = validateNewField(m.newField);
        if (checked.error) return res.status(400).json({ status: 'failed', message: checked.error });
        // A name the school already uses means that field, not a second one.
        field = liveByLabel.get(checked.value.label.toLowerCase()) || null;
        if (!field) {
          if (!can(req, 'students')) {
            return res.status(403).json({
              status: 'failed',
              code: 'PERMISSION_DENIED',
              message: 'Adding a custom field needs permission to edit students. You can still map questions to the existing fields.',
            });
          }
          const labelKey = checked.value.label.toLowerCase();
          if (seenNewLabels.has(labelKey)) {
            return res.status(400).json({ status: 'failed', message: `Two new fields are both called "${checked.value.label}"` });
          }
          seenNewLabels.add(labelKey);
          newField = checked.value;
        }
      }

      if (field) {
        if (seenCustom.has(field.fieldId)) {
          return res.status(400).json({ status: 'failed', message: `Two form fields both map to "${field.label}"` });
        }
        seenCustom.add(field.fieldId);
      }
      plan.push({ fieldId: m.fieldId, targetField: target.CUSTOM_TARGET, valueMap, customFieldId: field ? field.fieldId : null, newField });
      continue;
    }

    if (!VALID_TARGETS.has(m.targetField)) {
      return res.status(400).json({ status: 'failed', message: `Unknown target field "${m.targetField}"` });
    }
    if (seenTargets.has(m.targetField)) {
      return res.status(400).json({ status: 'failed', message: `Two form fields both map to "${m.targetField}"` });
    }
    seenTargets.add(m.targetField);
    plan.push({ fieldId: m.fieldId, targetField: m.targetField, valueMap, customFieldId: null, newField: null });
  }

  if (liveFields.length + seenNewLabels.size > LIMITS.fieldsPerSchool) {
    return res.status(400).json({
      status: 'failed',
      message: `A school can have at most ${LIMITS.fieldsPerSchool} custom fields, and this would make ${liveFields.length + seenNewLabels.size}.`,
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(importQueries.deleteMappingsByForm, [formId]);
    const createdFields = [];
    for (const m of plan) {
      let customFieldId = m.customFieldId;
      if (m.newField) {
        // In this same transaction, so the mapping and its new fields are
        // saved together or not at all. If someone added a field of that name
        // a moment ago, theirs is used.
        const { rows } = await client.query(customFieldQueries.getOrCreateField, [
          school, m.newField.label, m.newField.type,
          m.newField.options ? JSON.stringify(m.newField.options) : null, req.user.userId,
        ]);
        customFieldId = rows[0].field_id;
        if (rows[0].created) createdFields.push(toField(rows[0]));
      }
      await client.query(importQueries.upsertMapping, [
        formId, m.fieldId, m.targetField, m.valueMap ? JSON.stringify(m.valueMap) : null, customFieldId,
      ]);
    }
    await client.query('COMMIT');

    const { rows: saved } = await db.query(importQueries.selectMappingsByForm, [formId, school]);
    return res.status(200).json({
      status: 'success',
      data: {
        isSuggested: false,
        mappings: saved.map(toCamelMapping),
        customFields: await loadLiveFields(db, school),
        createdFields,
      },
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
    // The same payment filter the list shows, so "import all" means what is on screen.
    paymentState: parsePaymentState({ payment: scope.paymentState }),
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
      userId: req.user.userId,
    });
    if (!result.ok) {
      const code = result.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(code).json({ status: 'failed', message: result.message });
    }

    let message = 'Import undone';
    if (result.studentDeleted) {
      message = 'Import undone and student deleted';
    } else if (req.body?.deleteStudent === true && !result.createdByImport) {
      message = 'Import undone. The student was kept: they were already in SchoolMule before this import.';
    } else if (result.blockedBy.length > 0) {
      message = 'Import undone. The student was kept because other records depend on it.';
    }

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
