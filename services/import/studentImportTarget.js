// services/import/studentImportTarget.js
//
// Everything the import engine needs to know about students, and the only
// place in the import feature that knows students exist at all.
//
// The engine (engine.js) and the classifier (classify.js) know nothing about
// students: they talk to this module through what it exports at the bottom.
// Adding a second import target later (staff,
// parents) means writing a sibling module with the same shape plus one additive
// migration for its link column; the engine itself does not change.

const importQueries = require('../../queries/registrationImport.queries');
const bulkQueries = require('../../queries/bulk.queries');
const { readCalendarDate } = require('../../utils/calendarDate');
const { toField } = require('../customFields/fields');
const { normalizeValue, displayValue, readCustomFields, emptyCustomFields } = require('../customFields/values');

// The DB enum is GRADE = ('1'..'8', 'JK', 'SK'); values are compared and stored
// as these literal tokens.
const GRADE_VALUES = ['JK', 'SK', '1', '2', '3', '4', '5', '6', '7', '8'];
// students.gender is 'male' | 'female' | NULL (honorific_gender_migration.sql).
const GENDER_VALUES = ['female', 'male'];

// A form question saved into one of the school's custom fields: the mapping
// row's target_field is 'custom' and custom_field_id says which field. In the
// values a row maps to, and in the diff, such a field is keyed 'custom:<id>'.
const CUSTOM_TARGET = 'custom';
const CUSTOM_PREFIX = 'custom:';
const customKey = fieldId => `${CUSTOM_PREFIX}${fieldId}`;
const isCustomKey = key => typeof key === 'string' && key.startsWith(CUSTOM_PREFIX);
const customIdOf = key => key.slice(CUSTOM_PREFIX.length);

// Which student fields a form field can feed, and how each is validated.
// `column` is the students table column the value lands in.
const MAPPABLE_FIELDS = [
  { targetField: 'name',             column: 'name',               label: 'Student name',            dataType: 'text',     group: 'Student', required: true },
  { targetField: 'grade',            column: 'grade',              label: 'Grade',                   dataType: 'enum',     group: 'Student', required: true, enumValues: GRADE_VALUES },
  { targetField: 'gender',           column: 'gender',             label: 'Gender',                  dataType: 'enum',     group: 'Student', required: false, enumValues: GENDER_VALUES },
  { targetField: 'oen',              column: 'oen',                label: 'OEN',                     dataType: 'text',     group: 'Student', required: false },
  { targetField: 'dateOfBirth',      column: 'date_of_birth',      label: 'Date of birth',           dataType: 'date',     group: 'Student', required: false },
  { targetField: 'address',          column: 'address',            label: 'Residential address',     dataType: 'textarea', group: 'Student', required: false },
  { targetField: 'healthCardNumber', column: 'health_card_number', label: 'Health card number',      dataType: 'text',     group: 'Student', required: false },
  { targetField: 'medicalNotes',     column: 'medical_notes',      label: 'Medical / allergy notes', dataType: 'textarea', group: 'Student', required: false },
  { targetField: 'emergencyContact', column: 'emergency_contact',  label: 'Emergency contact',       dataType: 'textarea', group: 'Student', required: false },
  { targetField: 'studentEmail',     column: 'student_email',      label: 'Student — email',         dataType: 'email',    group: 'Student', required: false },

  { targetField: 'motherName',       column: 'mother_name',        label: 'Mother — name',           dataType: 'text',     group: 'Mother',  required: false },
  { targetField: 'motherEmail',      column: 'mother_email',       label: 'Mother — email',          dataType: 'email',    group: 'Mother',  required: false },
  { targetField: 'motherPhone',      column: 'mother_number',      label: 'Mother — phone',          dataType: 'phone',    group: 'Mother',  required: false },

  { targetField: 'fatherName',       column: 'father_name',        label: 'Father — name',           dataType: 'text',     group: 'Father',  required: false },
  { targetField: 'fatherEmail',      column: 'father_email',       label: 'Father — email',          dataType: 'email',    group: 'Father',  required: false },
  { targetField: 'fatherPhone',      column: 'father_number',      label: 'Father — phone',          dataType: 'phone',    group: 'Father',  required: false },
];

const FIELD_BY_TARGET = new Map(MAPPABLE_FIELDS.map(f => [f.targetField, f]));

// ─── Auto-suggestion ──────────────────────────────────────────────────
// Label heuristics, most specific first — order matters, since "Parent/Guardian
// phone number" must not be claimed by the looser /phone/ rule before the
// parent rules get a chance. Each target can only be claimed once.
const SUGGEST_RULES = [
  { targetField: 'name',             test: l => /name of (the )?(student|child)|student.{0,10}name|child.{0,10}name|full name of/.test(l) },
  // The student's own address, before the parent rules can claim "email".
  { targetField: 'studentEmail',     test: l => /(student|child).{0,15}e-?mail/.test(l) },
  { targetField: 'grade',            test: l => /grade|kindergarten|which class/.test(l) },
  { targetField: 'gender',           test: l => /\bgender\b|\bsex\b/.test(l) },
  { targetField: 'dateOfBirth',      test: l => /date of birth|birth ?date|\bdob\b/.test(l) },
  { targetField: 'oen',              test: l => /\boen\b|ontario education number/.test(l) },
  { targetField: 'healthCardNumber', test: l => /health card/.test(l) },
  { targetField: 'medicalNotes',     test: l => /medical|allerg|asthma|diabet|health condition/.test(l) },
  { targetField: 'emergencyContact', test: l => /emergency/.test(l) },
  { targetField: 'address',          test: l => /residential address|home address|^address|street address/.test(l) },
  { targetField: 'motherName',       test: l => /mother.{0,15}name/.test(l) },
  { targetField: 'motherEmail',      test: l => /mother.{0,15}e-?mail/.test(l) },
  { targetField: 'motherPhone',      test: l => /mother.{0,15}(phone|number|cell|mobile)/.test(l) },
  { targetField: 'fatherName',       test: l => /father.{0,15}name/.test(l) },
  { targetField: 'fatherEmail',      test: l => /father.{0,15}e-?mail/.test(l) },
  { targetField: 'fatherPhone',      test: l => /father.{0,15}(phone|number|cell|mobile)/.test(l) },
  // Generic parent/guardian wording falls through to the mother columns, which
  // is the convention the existing student records already follow. The admin
  // can reassign to father in the mapping editor.
  { targetField: 'motherName',       test: l => /(parent|guardian).{0,20}name/.test(l) },
  { targetField: 'motherEmail',      test: l => /(parent|guardian).{0,20}e-?mail|parents.{0,10}e-?mail/.test(l) },
  { targetField: 'motherPhone',      test: l => /(parent|guardian).{0,20}(phone|number|cell|mobile)/.test(l) },
];

// Best-effort translation of a choice option's text to a grade token.
// "Junior Kindergarten (born in 2022)" → 'JK'; "Grade 1" → '1'.
//
// Deliberately mirrored by guessEnumValue() in the frontend's
// FieldMappingEditor.tsx, which re-seeds the option map when an admin re-points
// a field mid-edit without a server round-trip. Keep the two regexes in sync.
function suggestGradeValue(optionText) {
  const l = String(optionText).toLowerCase();
  if (/junior\s*k|^jk\b|\bjk\b/.test(l)) return 'JK';
  if (/senior\s*k|^sk\b|\bsk\b/.test(l)) return 'SK';
  const m = l.match(/\b(\d{1,2})\b/);
  if (m && GRADE_VALUES.includes(m[1])) return m[1];
  return null;
}

// "Female", "Girl", "F" → 'female'; "Male", "Boy", "M" → 'male'. Female is
// tested first because "female" contains "male".
function suggestGenderValue(optionText) {
  const l = String(optionText).trim().toLowerCase();
  if (/\b(female|girl|woman)\b|^f$/.test(l)) return 'female';
  if (/\b(male|boy|man)\b|^m$/.test(l)) return 'male';
  return null;
}

// Best-effort translation of one answer option to a value of an enum target.
// Mirrored by guessEnumValue() in the frontend's src/lib/importMapping.ts.
function suggestEnumValue(targetField, optionText) {
  if (targetField === 'grade') return suggestGradeValue(optionText);
  if (targetField === 'gender') return suggestGenderValue(optionText);
  return null;
}

/**
 * Propose a mapping for a form's fields. Returns
 * [{ fieldId, targetField, valueMap }] covering only the fields it is
 * confident about; everything else is left unmapped for the admin to decide.
 */
function suggestMapping(fields) {
  const claimed = new Set();
  const out = [];

  for (const rule of SUGGEST_RULES) {
    if (claimed.has(rule.targetField)) continue;
    const field = fields.find(f =>
      !out.some(o => o.fieldId === f.field_id) && rule.test(String(f.label || '').toLowerCase())
    );
    if (!field) continue;

    let valueMap = null;
    if (FIELD_BY_TARGET.get(rule.targetField).dataType === 'enum' && Array.isArray(field.options)) {
      valueMap = {};
      for (const opt of field.options) {
        const v = suggestEnumValue(rule.targetField, opt);
        if (v) valueMap[opt] = v;
      }
    }
    claimed.add(rule.targetField);
    out.push({ fieldId: field.field_id, targetField: rule.targetField, valueMap });
  }

  return out;
}

// ─── Value coercion / validation ──────────────────────────────────────

// A mapping's own answer → value translation, when it has one for this answer.
const translateAnswer = (valueMap, raw) =>
  (valueMap && Object.prototype.hasOwnProperty.call(valueMap, raw) ? valueMap[raw] : undefined);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Turn one raw answer into the value that will be written to the DB.
 * Returns { ok: true, value } or { ok: false, error } — errors surface in the
 * preview as a non-importable row with a reason, never as a silent drop.
 */
function coerceValue(targetField, rawValue, valueMap) {
  const def = FIELD_BY_TARGET.get(targetField);
  if (!def) return { ok: false, error: `Unknown target field "${targetField}"` };

  const raw = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
  if (raw === '') return { ok: true, value: null };

  switch (def.dataType) {
    case 'enum': {
      // An explicit mapping wins; otherwise accept a value that already is a
      // valid token (e.g. a plain text field where a parent typed "3" or
      // "Female"), whatever its capitals.
      const mapped = translateAnswer(valueMap, raw)
        ?? def.enumValues.find(v => v.toLowerCase() === raw.toLowerCase())
        ?? (targetField === 'gender' ? suggestGenderValue(raw) : null);
      if (!mapped) {
        return { ok: false, error: `"${raw}" is not mapped to a ${def.label.toLowerCase()} value` };
      }
      if (!def.enumValues.includes(mapped)) {
        return { ok: false, error: `"${mapped}" is not a valid ${def.label.toLowerCase()}` };
      }
      return { ok: true, value: mapped };
    }

    case 'date': {
      // ISO (what the form's date input produces) or D/M/Y typed into a text
      // field, and only a day that exists: 31 February is refused here, as
      // this row's problem, rather than by Postgres in the middle of the import.
      return readCalendarDate(raw);
    }

    case 'email':
      if (!EMAIL_RE.test(raw)) return { ok: false, error: `"${raw}" is not a valid email address` };
      return { ok: true, value: raw.toLowerCase() };

    case 'phone': {
      // Store as typed — the app has no phone format convention — but reject
      // anything with no digits at all, which is always a mis-mapping.
      if (!/\d/.test(raw)) return { ok: false, error: `"${raw}" does not look like a phone number` };
      return { ok: true, value: raw };
    }

    default:
      return { ok: true, value: raw };
  }
}

// ─── Custom fields ────────────────────────────────────────────────────

// The custom field a mapping row feeds, in the shape the value rules use
// (selectMappingsByForm joins its definition onto the row), or null for a
// built-in target.
function customFieldOf(mapping) {
  if (!mapping || !mapping.custom_field_id) return null;
  return toField({
    field_id: mapping.custom_field_id,
    label: mapping.custom_label,
    field_type: mapping.custom_type,
    options: mapping.custom_options,
  });
}

/** What a mapping row's value is keyed by: the target field, or 'custom:<fieldId>'. */
const mappingKey = mapping => (mapping.custom_field_id ? customKey(mapping.custom_field_id) : mapping.target_field);

/**
 * Turn one raw answer into the value a mapping row writes. A custom field is
 * read by the same rules as the student form (customFields/values.js), after
 * the mapping's own answer → choice translation when it has one.
 */
function coerceMapped(mapping, rawValue) {
  const field = customFieldOf(mapping);
  if (!field) return coerceValue(mapping.target_field, rawValue, mapping.value_map);

  const raw = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim();
  return normalizeValue(field, translateAnswer(mapping.value_map, raw) ?? raw);
}

// The custom fields a row would save, labelled for the preview:
// [{ fieldId, label, display }].
function describeExtras(values, mappings) {
  const out = [];
  for (const m of mappings) {
    const field = customFieldOf(m);
    if (!field) continue;
    const value = values[customKey(field.fieldId)];
    if (value === undefined || value === null) continue;
    out.push({ fieldId: field.fieldId, label: field.label, display: displayValue(field, value) });
  }
  return out;
}

// { fieldId: value } for the custom-field entries of a values object.
function customValuesOf(values) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (isCustomKey(key) && value !== null && value !== undefined) out[customIdOf(key)] = value;
  }
  return out;
}

// ─── Candidates ───────────────────────────────────────────────────────

async function loadCandidates(client, { school, schoolYearId }) {
  const { rows } = await client.query(importQueries.selectStudentsForMatching, [school, schoolYearId]);
  return rows;
}

const getCandidateName = row => row.name;
const getCandidateGrade = row => row.grade;
const getCandidateId = row => row.student_id;

// A student this import is about to create, as a stand-in candidate, so a
// later submission for the same child in the same run is matched against it
// instead of being created a second time.
const pendingCandidate = (submissionId, values) => ({
  student_id: `pending:${submissionId}`,
  name: values.name,
  grade: values.grade,
});

// A field counts as blank when it is NULL or whitespace-only — fill-blanks-only
// updates treat an empty string the same as no value.
function isBlank(candidateRow, targetField) {
  if (isCustomKey(targetField)) {
    // No key means no value; false and 0 are answers, not blanks.
    const v = readCustomFields(candidateRow.custom_fields).values[customIdOf(targetField)];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  }
  const def = FIELD_BY_TARGET.get(targetField);
  if (!def) return false;
  const v = candidateRow[def.column];
  return v === null || v === undefined || String(v).trim() === '';
}

/**
 * Fill-blanks-only diff: which mapped values would actually be written to an
 * existing student. Never proposes overwriting a field that already has data.
 */
function diffFillable(candidateRow, values, mappings = []) {
  const customByKey = new Map();
  for (const m of mappings) {
    const field = customFieldOf(m);
    if (field) customByKey.set(customKey(field.fieldId), field);
  }

  const diff = [];
  for (const [targetField, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === '') continue;
    if (!isBlank(candidateRow, targetField)) continue;

    if (isCustomKey(targetField)) {
      const field = customByKey.get(targetField);
      if (!field) continue;
      // `to` is what the admin reads; `value` is what is written (a number
      // stays a number, yes/no stays a boolean).
      diff.push({ targetField, label: field.label, from: null, to: displayValue(field, value), value });
      continue;
    }
    const def = FIELD_BY_TARGET.get(targetField);
    diff.push({ targetField, label: def.label, from: null, to: String(value) });
  }
  return diff;
}

// ─── Writes ───────────────────────────────────────────────────────────

async function applyCreate(client, values, { school, schoolYearId, submissionId, homeroomTeacherId }) {
  const { rows } = await client.query(importQueries.insertStudentFromSubmission, [
    values.name,
    values.grade,
    school,
    schoolYearId,
    homeroomTeacherId || null,
    values.oen ?? null,
    values.dateOfBirth ?? null,
    values.address ?? null,
    values.healthCardNumber ?? null,
    values.medicalNotes ?? null,
    values.emergencyContact ?? null,
    values.motherName ?? null,
    values.motherEmail ?? null,
    values.motherPhone ?? null,
    values.fatherName ?? null,
    values.fatherEmail ?? null,
    values.fatherPhone ?? null,
    submissionId,
    values.studentEmail ?? null,
    values.gender ?? null,
    JSON.stringify({ ...emptyCustomFields(), values: customValuesOf(values) }),
  ]);
  return rows[0];
}

/**
 * Apply a fill-blanks-only update. The COALESCE in the SQL is a second line of
 * defence — `diff` has already excluded every non-blank column — so a field
 * that gained a value between preview and execute still cannot be overwritten.
 */
async function applyUpdate(client, studentId, diff) {
  if (diff.length === 0) return null;
  const byTarget = new Map(diff.map(d => [d.targetField, d.to]));
  const param = t => (byTarget.has(t) ? byTarget.get(t) : null);

  const customPatch = {};
  for (const d of diff) {
    if (isCustomKey(d.targetField)) customPatch[customIdOf(d.targetField)] = d.value;
  }

  const { rows } = await client.query(importQueries.updateStudentFillBlanks, [
    studentId,
    param('name'),
    param('grade'),
    param('oen'),
    param('dateOfBirth'),
    param('address'),
    param('healthCardNumber'),
    param('medicalNotes'),
    param('emergencyContact'),
    param('motherName'),
    param('motherEmail'),
    param('motherPhone'),
    param('fatherName'),
    param('fatherEmail'),
    param('fatherPhone'),
    param('studentEmail'),
    param('gender'),
    Object.keys(customPatch).length > 0 ? JSON.stringify(customPatch) : null,
  ]);
  return rows[0] || null;
}

// Tables whose rows would be destroyed (or would block a delete) if an imported
// student were removed. Enumerated from the live FK graph — every table with a
// foreign key onto students.student_id. Undo consults this before offering to
// delete, because most of these cascade silently.
const dependentTables = [
  { table: 'class_students',              column: 'student_id', label: 'class enrolments' },
  { table: 'student_assessments',         column: 'student_id', label: 'assessment scores' },
  { table: 'modified_marks',              column: 'student_id', label: 'modified marks' },
  { table: 'student_excluded_assessments',column: 'student_id', label: 'assessment exclusions' },
  { table: 'class_attendance',            column: 'student_id', label: 'class attendance' },
  { table: 'general_attendance',          column: 'student_id', label: 'general attendance' },
  { table: 'report_cards',                column: 'student_id', label: 'report cards' },
  { table: 'report_card_feedback',        column: 'student_id', label: 'report card feedback' },
  { table: 'report_emails',               column: 'student_id', label: 'report emails' },
  { table: 'progress_reports',            column: 'student_id', label: 'progress reports' },
  { table: 'progress_report_feedback',    column: 'student_id', label: 'progress report feedback' },
  { table: 'parent_students',             column: 'student_id', label: 'parent links' },
  { table: 'student_view_emails',         column: 'student_id', label: 'student view emails' },
  { table: 'jk_skill_assessments',        column: 'student_id', label: 'JK skill assessments' },
  { table: 'jk_learning_skills',          column: 'student_id', label: 'JK learning skills' },
  { table: 'jk_domain_comments',          column: 'student_id', label: 'JK domain comments' },
  { table: 'jk_progress_report_comments', column: 'student_id', label: 'JK progress comments' },
  { table: 'jk_teacher_assistants',       column: 'student_id', label: 'JK teacher assistants' },
  { table: 'sk_standard_assessments',     column: 'student_id', label: 'SK standard assessments' },
  { table: 'sk_subject_comments',         column: 'student_id', label: 'SK subject comments' },
  { table: 'sk_progress_report_comments', column: 'student_id', label: 'SK progress comments' },
  { table: 'sk_teacher_assistants',       column: 'student_id', label: 'SK teacher assistants' },
  { table: 'students',                    column: 'previous_student_id', label: 'next-year records' },
  { table: 'student_account_links',       column: 'student_id', label: 'student login' },
];

// ─── Optional batch side effects ──────────────────────────────────────

async function assignHomeroomTeacher(client, studentIds, teacherId) {
  if (studentIds.length === 0 || !teacherId) return;
  await client.query(importQueries.assignHomeroomTeacher, [studentIds, teacherId]);
}

/**
 * Enrol the imported students into the classes for their own grade.
 * Uses enrollSpecificStudents (this batch's IDs only) rather than
 * enrollAllInGrade, which would sweep in every other student in the grade.
 */
async function enrollInGradeClasses(client, students, { school, schoolYearId }) {
  const byGrade = new Map();
  for (const s of students) {
    if (!s || !s.grade) continue;
    if (!byGrade.has(s.grade)) byGrade.set(s.grade, []);
    byGrade.get(s.grade).push(s.student_id);
  }

  let enrolled = 0;
  for (const [grade, ids] of byGrade) {
    const { rows: classes } = await client.query(
      importQueries.selectClassesByGradeForYear,
      [school, schoolYearId, grade],
    );
    for (const cls of classes) {
      await client.query(bulkQueries.enrollSpecificStudents, [cls.class_id, ids]);
      enrolled += ids.length;
    }
  }
  return enrolled;
}

module.exports = {
  key: 'student',
  label: 'Students',
  GRADE_VALUES,
  GENDER_VALUES,
  CUSTOM_TARGET,
  customKey,
  mappableFields: MAPPABLE_FIELDS,
  fieldByTarget: FIELD_BY_TARGET,
  suggestMapping,
  suggestGradeValue,
  suggestEnumValue,
  coerceValue,
  mappingKey,
  coerceMapped,
  describeExtras,
  loadCandidates,
  getCandidateName,
  getCandidateGrade,
  getCandidateId,
  pendingCandidate,
  isBlank,
  diffFillable,
  applyCreate,
  applyUpdate,
  dependentTables,
  sideEffects: { assignHomeroomTeacher, enrollInGradeClasses },
};
