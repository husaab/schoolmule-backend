// services/customFields/values.js
//
// The rules for student custom fields, in one place: what a field definition
// may look like, and how a value is read for each field type.
//
// Both ways a value arrives go through normalizeValue: the student form sends
// typed JSON (a number, true/false), the forms import sends the strings a
// parent typed. One function for both, so the two can't disagree about what
// counts as a number or a date.
//
// Stored on students_all.custom_fields as
//   { values: { <fieldId>: value }, notes: [{ label, value }] }
// where a value is a string (text, textarea, select, date as YYYY-MM-DD), a
// number, or a boolean. A field with no value has no key: '' and null are
// never stored, which is what lets the import's "fill blanks only" be a plain
// key check.

const { readCalendarDate } = require('../../utils/calendarDate');

const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'boolean'];

const LIMITS = {
  fieldsPerSchool: 100,
  label: 80,
  options: 50,
  option: 100,
  text: 500,
  textarea: 5000,
  notes: 20,
  noteLabel: 80,
  noteValue: 1000,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const MAX_NUMBER = 1e12;

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const emptyCustomFields = () => ({ values: {}, notes: [] });

/** The stored JSON as { values, notes }, whatever shape (or nothing) is in the column. */
function readCustomFields(raw) {
  const stored = isPlainObject(raw) ? raw : {};
  return {
    values: isPlainObject(stored.values) ? stored.values : {},
    notes: Array.isArray(stored.notes)
      ? stored.notes
          .filter((n) => isPlainObject(n) && typeof n.label === 'string')
          .map((n) => ({ label: n.label, value: n.value === null || n.value === undefined ? '' : String(n.value) }))
      : [],
  };
}

// ─── Definitions ──────────────────────────────────────────────────────

function cleanLabel(raw) {
  if (typeof raw !== 'string') return { error: 'Give the field a name' };
  const label = raw.trim().replace(/\s+/g, ' ');
  if (!label) return { error: 'Give the field a name' };
  if (label.length > LIMITS.label) return { error: `A field name can be at most ${LIMITS.label} characters` };
  return { value: label };
}

function cleanOptions(raw) {
  if (!Array.isArray(raw)) return { error: 'A dropdown needs at least one choice' };
  const seen = new Set();
  const options = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { error: 'Each dropdown choice must be text' };
    const option = item.trim().replace(/\s+/g, ' ');
    if (!option) continue;
    if (option.length > LIMITS.option) return { error: `A dropdown choice can be at most ${LIMITS.option} characters` };
    const key = option.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }
  if (options.length === 0) return { error: 'A dropdown needs at least one choice' };
  if (options.length > LIMITS.options) return { error: `A dropdown can have at most ${LIMITS.options} choices` };
  return { value: options };
}

/**
 * A new field from a request body: { value: { label, type, options } } or
 * { error }. `options` is the cleaned list for a dropdown and null otherwise.
 */
function validateNewField(body) {
  const input = isPlainObject(body) ? body : {};
  const label = cleanLabel(input.label);
  if (label.error) return { error: label.error };
  if (!FIELD_TYPES.includes(input.type)) return { error: 'Choose what kind of field this is' };

  if (input.type !== 'select') return { value: { label: label.value, type: input.type, options: null } };
  const options = cleanOptions(input.options);
  if (options.error) return { error: options.error };
  return { value: { label: label.value, type: 'select', options: options.value } };
}

/**
 * A change to an existing field: its name and, for a dropdown, its choices.
 * The type never changes — the values already saved were read as that type.
 * Returns { value: { label?, options? } } with only what the body carried.
 */
function validateFieldChange(body, existingType) {
  const input = isPlainObject(body) ? body : {};
  if (input.type !== undefined && input.type !== existingType) {
    return { error: "A field's type can't be changed. Delete it and add a new one." };
  }
  const change = {};
  if (input.label !== undefined) {
    const label = cleanLabel(input.label);
    if (label.error) return { error: label.error };
    change.label = label.value;
  }
  if (input.options !== undefined && input.options !== null) {
    if (existingType !== 'select') return { error: 'Only a dropdown has choices' };
    const options = cleanOptions(input.options);
    if (options.error) return { error: options.error };
    change.options = options.value;
  }
  return { value: change };
}

// ─── Values ───────────────────────────────────────────────────────────

/**
 * Read one value for a field. `input` is typed JSON from the student form or
 * a string from a form answer.
 * Returns { ok: true, value } (value null = nothing entered) or { ok: false, error }.
 */
function normalizeValue(def, input) {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input === 'object') return { ok: false, error: `${def.label} has a value that can't be saved` };
  const text = typeof input === 'string' ? input.trim() : null;
  if (text === '') return { ok: true, value: null };

  switch (def.type) {
    case 'text':
    case 'textarea': {
      const value = text === null ? String(input) : text;
      const max = def.type === 'text' ? LIMITS.text : LIMITS.textarea;
      if (value.length > max) return { ok: false, error: `${def.label} can be at most ${max} characters` };
      return { ok: true, value };
    }

    case 'number': {
      let value;
      if (typeof input === 'number') value = input;
      else if (text !== null && NUMBER_RE.test(text)) value = Number(text);
      else return { ok: false, error: `${def.label} needs a number, and "${input}" isn't one` };
      if (!Number.isFinite(value) || Math.abs(value) >= MAX_NUMBER) {
        return { ok: false, error: `${def.label} has a number that is too large` };
      }
      return { ok: true, value };
    }

    case 'date': {
      if (text === null) return { ok: false, error: `${def.label} needs a date` };
      return readCalendarDate(text);
    }

    case 'select': {
      const wanted = (text === null ? String(input) : text).toLowerCase();
      const match = (def.options || []).find((o) => o.toLowerCase() === wanted);
      if (match === undefined) {
        return { ok: false, error: `"${input}" is not one of the choices for ${def.label}` };
      }
      return { ok: true, value: match };
    }

    case 'boolean': {
      if (typeof input === 'boolean') return { ok: true, value: input };
      const word = String(input).trim().toLowerCase();
      if (TRUE_WORDS.has(word)) return { ok: true, value: true };
      if (FALSE_WORDS.has(word)) return { ok: true, value: false };
      return { ok: false, error: `${def.label} needs yes or no, and "${input}" is neither` };
    }

    default:
      return { ok: false, error: `${def.label} has an unknown field type` };
  }
}

/** A value as a person reads it: Yes/No for a boolean, the text otherwise. */
function displayValue(def, value) {
  if (value === null || value === undefined) return '';
  if (def.type === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function cleanNotes(raw) {
  if (!Array.isArray(raw)) return { error: 'Notes must be a list' };
  const notes = [];
  for (const item of raw) {
    if (!isPlainObject(item)) return { error: 'Each note needs a label and a value' };
    const label = typeof item.label === 'string' ? item.label.trim().replace(/\s+/g, ' ') : '';
    const value = item.value === null || item.value === undefined ? '' : String(item.value).trim();
    if (!label && !value) continue; // an untouched row in the form
    if (!label) return { error: 'Give each note a label' };
    if (!value) continue; // a label with nothing beside it says nothing
    if (label.length > LIMITS.noteLabel) return { error: `A note label can be at most ${LIMITS.noteLabel} characters` };
    if (value.length > LIMITS.noteValue) return { error: `A note can be at most ${LIMITS.noteValue} characters` };
    notes.push({ label, value });
  }
  if (notes.length > LIMITS.notes) return { error: `A student can have at most ${LIMITS.notes} notes` };
  return { value: notes };
}

/**
 * The `customFields` of a student create/update body, checked against the
 * school's fields.
 *
 *   input     { values?: { <fieldId>: value | null }, notes?: [{ label, value }] }
 *   defsById  Map of the school's live fields
 *
 * Returns { patch } or { error }. `patch.values` holds only the keys the body
 * carried, with null for a cleared field (the SQL merges it into what is
 * stored, so a field the form never touched is left alone); `patch.notes`,
 * when present, replaces the student's notes.
 */
function normalizeCustomFieldsInput(input, defsById) {
  if (!isPlainObject(input)) return { error: 'Custom fields must be an object' };
  const patch = {};

  if (input.values !== undefined && input.values !== null) {
    if (!isPlainObject(input.values)) return { error: 'Custom field values must be an object' };
    patch.values = {};
    for (const [fieldId, raw] of Object.entries(input.values)) {
      const def = UUID_RE.test(fieldId) ? defsById.get(fieldId.toLowerCase()) : null;
      if (!def) return { error: 'One of the custom fields no longer exists. Reload the page and try again.' };
      const result = normalizeValue(def, raw);
      if (!result.ok) return { error: result.error };
      patch.values[def.fieldId] = result.value;
    }
  }

  if (input.notes !== undefined && input.notes !== null) {
    const notes = cleanNotes(input.notes);
    if (notes.error) return { error: notes.error };
    patch.notes = notes.value;
  }

  return { patch };
}

module.exports = {
  FIELD_TYPES,
  LIMITS,
  UUID_RE,
  emptyCustomFields,
  readCustomFields,
  validateNewField,
  validateFieldChange,
  normalizeValue,
  displayValue,
  normalizeCustomFieldsInput,
};
