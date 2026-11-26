/*
  controllers/studentCustomFields.controller.js
  /api/student-custom-fields: the school's own student fields ("Bus route",
  "Photo consent"), shown on every student beside the built-in ones.

  Anyone who edits students can add a field (routes: `students`); renaming,
  reordering, deleting and restoring are school setup. Delete only hides a
  field: the values stay on the students and restore brings them back.
  The school always comes from the token.
*/

const db = require('../config/database');
const logger = require('../logger');
const queries = require('../queries/studentCustomFields.queries');
const { toField, loadLiveFields } = require('../services/customFields/fields');
const { validateNewField, validateFieldChange, LIMITS, UUID_RE } = require('../services/customFields/values');

const UNIQUE_VIOLATION = '23505';

const failed = (res, status, message, extra = {}) => res.status(status).json({ status: 'failed', message, ...extra });
const notFound = (res) => failed(res, 404, 'Custom field not found');
const nameTaken = (res, label) => failed(res, 409, `A field called "${label}" already exists`, { code: 'FIELD_NAME_TAKEN' });

// A :id that isn't an id is a field that doesn't exist (routes: router.param).
const requireFieldId = (req, res, next, id) => (UUID_RE.test(id) ? next() : notFound(res));

// The school is at its limit: the 400 to send, else null.
const refuseAtLimit = async (res, school) => {
  const { rows: [{ count }] } = await db.query(queries.countLiveFields, [school]);
  if (count < LIMITS.fieldsPerSchool) return null;
  return failed(res, 400, `A school can have at most ${LIMITS.fieldsPerSchool} custom fields. Delete one you no longer use first.`);
};

// GET /api/student-custom-fields
const listFields = async (req, res) => {
  try {
    return res.status(200).json({ status: 'success', data: await loadLiveFields(db, req.user.school) });
  } catch (error) {
    logger.error({ err: error }, 'Error loading student custom fields');
    return failed(res, 500, 'Error loading custom fields');
  }
};

// GET /api/student-custom-fields/deleted
const listDeletedFields = async (req, res) => {
  try {
    const { rows } = await db.query(queries.selectDeletedFields, [req.user.school]);
    return res.status(200).json({
      status: 'success',
      data: rows.map((row) => ({
        ...toField(row),
        deletedAt: row.deleted_at,
        deletedByName: row.deleted_by_name || null,
      })),
    });
  } catch (error) {
    logger.error({ err: error }, 'Error loading deleted student custom fields');
    return failed(res, 500, 'Error loading deleted custom fields');
  }
};

// POST /api/student-custom-fields  { label, type, options? }
const createField = async (req, res) => {
  const checked = validateNewField(req.body);
  if (checked.error) return failed(res, 400, checked.error);
  const { label, type, options } = checked.value;

  try {
    if (await refuseAtLimit(res, req.user.school)) return undefined;
    const { rows } = await db.query(queries.insertField, [
      req.user.school, label, type, options ? JSON.stringify(options) : null, req.user.userId,
    ]);
    logger.info({ fieldId: rows[0].field_id, by: req.user.userId }, 'Student custom field added');
    return res.status(201).json({ status: 'success', data: toField(rows[0]) });
  } catch (error) {
    if (error.code === UNIQUE_VIOLATION) return nameTaken(res, label);
    logger.error({ err: error }, 'Error adding student custom field');
    return failed(res, 500, 'Error adding the custom field');
  }
};

// PATCH /api/student-custom-fields/:id  { label?, options? }
const updateField = async (req, res) => {
  const { id } = req.params;

  let change;
  try {
    const { rows } = await db.query(queries.selectFieldById, [id, req.user.school]);
    if (rows.length === 0 || rows[0].deleted_at) return notFound(res);

    const checked = validateFieldChange(req.body, rows[0].field_type);
    if (checked.error) return failed(res, 400, checked.error);
    change = checked.value;

    const updated = await db.query(queries.updateField, [
      id, req.user.school, change.label ?? null, change.options ? JSON.stringify(change.options) : null,
    ]);
    if (updated.rows.length === 0) return notFound(res);
    return res.status(200).json({ status: 'success', data: toField(updated.rows[0]) });
  } catch (error) {
    if (error.code === UNIQUE_VIOLATION) return nameTaken(res, change?.label);
    logger.error({ err: error }, 'Error updating student custom field');
    return failed(res, 500, 'Error updating the custom field');
  }
};

// PUT /api/student-custom-fields/order  { order: [fieldId, ...] }
const reorderFields = async (req, res) => {
  const order = req.body?.order;
  if (!Array.isArray(order) || !order.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
    return failed(res, 400, 'order must be the list of field ids');
  }

  try {
    // The whole list or nothing: a stale page (someone added a field meanwhile)
    // is refused rather than leaving two fields on the same position.
    const live = await loadLiveFields(db, req.user.school);
    const wanted = new Set(order.map((id) => id.toLowerCase()));
    if (wanted.size !== order.length || wanted.size !== live.length || !live.every((f) => wanted.has(f.fieldId))) {
      return failed(res, 409, 'The list of fields changed. Reload and try again.', { code: 'FIELDS_CHANGED' });
    }
    await db.query(queries.reorderFields, [req.user.school, order]);
    return res.status(200).json({ status: 'success', data: await loadLiveFields(db, req.user.school) });
  } catch (error) {
    logger.error({ err: error }, 'Error reordering student custom fields');
    return failed(res, 500, 'Error reordering custom fields');
  }
};

// GET /api/student-custom-fields/:id/usage
const getFieldUsage = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: found } = await db.query(queries.selectFieldById, [id, req.user.school]);
    if (found.length === 0) return notFound(res);
    const schoolYearId = req.schoolYear?.schoolYearId || null;
    const { rows } = await db.query(queries.selectFieldUsage, [id, req.user.school, schoolYearId]);
    return res.status(200).json({
      status: 'success',
      data: { studentCount: rows[0].student_count, formCount: rows[0].form_count },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error loading student custom field usage');
    return failed(res, 500, 'Error loading how the field is used');
  }
};

// DELETE /api/student-custom-fields/:id
const deleteField = async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(queries.softDeleteField, [id, req.user.school, req.user.userId]);
    if (rows.length === 0) return notFound(res);
    logger.info({ fieldId: id, by: req.user.userId }, 'Student custom field deleted (kept, restorable)');
    return res.status(200).json({ status: 'success', message: `"${rows[0].label}" deleted`, data: toField(rows[0]) });
  } catch (error) {
    logger.error({ err: error }, 'Error deleting student custom field');
    return failed(res, 500, 'Error deleting the custom field');
  }
};

// POST /api/student-custom-fields/:id/restore
const restoreField = async (req, res) => {
  const { id } = req.params;

  let label;
  try {
    const { rows: found } = await db.query(queries.selectFieldById, [id, req.user.school]);
    if (found.length === 0 || !found[0].deleted_at) {
      return failed(res, 404, "This field isn't in Deleted fields");
    }
    label = found[0].label;

    if (await refuseAtLimit(res, req.user.school)) return undefined;
    const { rows } = await db.query(queries.restoreField, [id, req.user.school]);
    if (rows.length === 0) return failed(res, 404, "This field isn't in Deleted fields");
    logger.info({ fieldId: id, by: req.user.userId }, 'Student custom field restored');
    return res.status(200).json({ status: 'success', message: `"${rows[0].label}" is back`, data: toField(rows[0]) });
  } catch (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return failed(res, 409, `Another field is called "${label}" now. Rename that one, then restore this.`, { code: 'FIELD_NAME_TAKEN' });
    }
    logger.error({ err: error }, 'Error restoring student custom field');
    return failed(res, 500, 'Error restoring the custom field');
  }
};

module.exports = {
  requireFieldId,
  listFields,
  listDeletedFields,
  createField,
  updateField,
  reorderFields,
  getFieldUsage,
  deleteField,
  restoreField,
};
