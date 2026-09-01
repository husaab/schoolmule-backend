// services/import/studentImportTarget.js
//
// Everything the import engine needs to know about students, and the only
// place in the import feature that knows students exist at all.
//
// The engine (engine.js) and the classifier (classify.js) talk to this module
// through a fixed shape — mappableFields / suggestMapping / coerceValue /
// loadCandidates / buildCreateParams / diffFillable / applyCreate / applyUpdate /
// dependentTables / sideEffects. Adding a second import target later (staff,
// parents) means writing a sibling module with the same shape plus one additive
// migration for its link column; the engine itself does not change.

const importQueries = require('../../queries/registrationImport.queries');
const bulkQueries = require('../../queries/bulk.queries');

// The DB enum is GRADE = ('1'..'8', 'JK', 'SK'); values are compared and stored
// as these literal tokens.
const GRADE_VALUES = ['JK', 'SK', '1', '2', '3', '4', '5', '6', '7', '8'];

// Which student fields a form field can feed, and how each is validated.
// `column` is the students table column the value lands in.
const MAPPABLE_FIELDS = [
  { targetField: 'name',             column: 'name',               label: 'Student name',            dataType: 'text',     group: 'Student', required: true },
  { targetField: 'grade',            column: 'grade',              label: 'Grade',                   dataType: 'enum',     group: 'Student', required: true, enumValues: GRADE_VALUES },
  { targetField: 'oen',              column: 'oen',                label: 'OEN',                     dataType: 'text',     group: 'Student', required: false },
  { targetField: 'dateOfBirth',      column: 'date_of_birth',      label: 'Date of birth',           dataType: 'date',     group: 'Student', required: false },
  { targetField: 'address',          column: 'address',            label: 'Residential address',     dataType: 'textarea', group: 'Student', required: false },
  { targetField: 'healthCardNumber', column: 'health_card_number', label: 'Health card number',      dataType: 'text',     group: 'Student', required: false },
  { targetField: 'medicalNotes',     column: 'medical_notes',      label: 'Medical / allergy notes', dataType: 'textarea', group: 'Student', required: false },
  { targetField: 'emergencyContact', column: 'emergency_contact',  label: 'Emergency contact',       dataType: 'textarea', group: 'Student', required: false },

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
  { targetField: 'grade',            test: l => /grade|kindergarten|which class/.test(l) },
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
function suggestGradeValue(optionText) {
  const l = String(optionText).toLowerCase();
  if (/junior\s*k|^jk\b|\bjk\b/.test(l)) return 'JK';
  if (/senior\s*k|^sk\b|\bsk\b/.test(l)) return 'SK';
  const m = l.match(/\b(\d{1,2})\b/);
  if (m && GRADE_VALUES.includes(m[1])) return m[1];
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
    if (rule.targetField === 'grade' && Array.isArray(field.options)) {
      valueMap = {};
      for (const opt of field.options) {
        const v = suggestGradeValue(opt);
        if (v) valueMap[opt] = v;
      }
    }
    claimed.add(rule.targetField);
    out.push({ fieldId: field.field_id, targetField: rule.targetField, valueMap });
  }

  return out;
}

// ─── Value coercion / validation ──────────────────────────────────────

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
      // valid token (e.g. a plain text field where a parent typed "3").
      const mapped = valueMap && Object.prototype.hasOwnProperty.call(valueMap, raw)
        ? valueMap[raw]
        : (GRADE_VALUES.includes(raw.toUpperCase()) ? raw.toUpperCase() : null);
      if (!mapped) {
        return { ok: false, error: `"${raw}" is not mapped to a ${def.label.toLowerCase()} value` };
      }
      if (!def.enumValues.includes(mapped)) {
        return { ok: false, error: `"${mapped}" is not a valid ${def.label.toLowerCase()}` };
      }
      return { ok: true, value: mapped };
    }

    case 'date': {
      // Accept ISO (what the form's date input produces) and D/M/Y or M/D/Y
      // typed into a text field. Ambiguous slash dates are read as D/M/Y,
      // matching the en-CA convention used across the app.
      const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (iso) return { ok: true, value: raw };

      const slash = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
      if (slash) {
        const [, a, b, y] = slash;
        const day = parseInt(a, 10);
        const month = parseInt(b, 10);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          return { ok: true, value: `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
        }
      }
      return { ok: false, error: `"${raw}" is not a recognizable date` };
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

// ─── Candidates ───────────────────────────────────────────────────────

async function loadCandidates(client, { school, schoolYearId }) {
  const { rows } = await client.query(importQueries.selectStudentsForMatching, [school, schoolYearId]);
  return rows;
}

const getCandidateName = row => row.name;
const getCandidateGrade = row => row.grade;
const getCandidateId = row => row.student_id;

// A field counts as blank when it is NULL or whitespace-only — fill-blanks-only
// updates treat an empty string the same as no value.
function isBlank(candidateRow, targetField) {
  const def = FIELD_BY_TARGET.get(targetField);
  if (!def) return false;
  const v = candidateRow[def.column];
  return v === null || v === undefined || String(v).trim() === '';
}

/**
 * Fill-blanks-only diff: which mapped values would actually be written to an
 * existing student. Never proposes overwriting a field that already has data.
 */
function diffFillable(candidateRow, values) {
  const diff = [];
  for (const [targetField, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === '') continue;
    if (!isBlank(candidateRow, targetField)) continue;
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
  mappableFields: MAPPABLE_FIELDS,
  fieldByTarget: FIELD_BY_TARGET,
  suggestMapping,
  suggestGradeValue,
  coerceValue,
  loadCandidates,
  getCandidateName,
  getCandidateGrade,
  getCandidateId,
  isBlank,
  diffFillable,
  applyCreate,
  applyUpdate,
  dependentTables,
  sideEffects: { assignHomeroomTeacher, enrollInGradeClasses },
  // Unused today, but names the coupling explicitly so a second target has an
  // obvious place to declare its own link column.
  submissionLinkColumn: 'imported_student_id',
};
