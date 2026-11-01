// services/reportEngine/fields.js
//
// A template's extra fields (TemplateDoc.fields, merge field {{extra.<key>}})
// and the values staff fill in per student, document type and term
// (report_field_values). ReportData.extra is where those values print from.

const db = require('../../config/database');
const q = require('../../queries/reportTemplates.queries');

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

/** { key: value } stored for one student's report. */
async function loadFieldValues({ studentId, docType, term, client = db }) {
  const { rows } = await client.query(q.selectFieldValues, [studentId, docType, term]);
  const values = {};
  for (const r of rows) if (!isBlank(r.value)) values[r.field_key] = r.value;
  return values;
}

/** The fields' default values, overlaid with what was filled in. */
function mergeExtras(fields, stored = {}) {
  const extra = {};
  for (const f of fields || []) {
    if (f && f.key && !isBlank(f.defaultValue)) extra[f.key] = String(f.defaultValue);
  }
  for (const [k, v] of Object.entries(stored || {})) {
    if (!isBlank(v)) extra[k] = String(v);
  }
  return extra;
}

/** The required fields still empty in `extra`. */
function missingRequired(fields, extra = {}) {
  return (fields || []).filter((f) => f && f.required && isBlank(extra[f.key]));
}

module.exports = { loadFieldValues, mergeExtras, missingRequired, isBlank };
