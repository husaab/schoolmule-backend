// services/customFields/fields.js
//
// Reading the school's custom fields. The student controller, the fields'
// own controller and the forms import all load them through here, so each
// works with the same { fieldId, label, type, options } shape.

const queries = require('../../queries/studentCustomFields.queries');

/** A student_custom_fields row as the API and the value rules see it. */
const toField = (row) => ({
  fieldId: row.field_id,
  label: row.label,
  type: row.field_type,
  options: Array.isArray(row.options) ? row.options : null,
  sortOrder: row.sort_order,
});

/** The fields in use, in the school's order. `db` is the pool or a transaction client. */
async function loadLiveFields(db, school) {
  const { rows } = await db.query(queries.selectLiveFields, [school]);
  return rows.map(toField);
}

const fieldsById = (fields) => new Map(fields.map((f) => [f.fieldId, f]));

module.exports = { toField, loadLiveFields, fieldsById };
