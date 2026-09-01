// services/submissionFilters.js
//
// Dynamic SQL builders for querying registration form submissions.
//
// Submissions store their answers as a single JSONB blob keyed by field UUID,
// so sorting and filtering have to happen at the DB level (the list is
// paginated — we can't sort in JS after the fact).
//
// These live outside the controller because three separate call sites need the
// *identical* semantics: the submissions list, the CSV export, and the
// "import all submissions matching the current filters" batch scope. If the
// import resolved its scope with its own copy of this logic, the batch would
// silently import a different set of rows than the admin sees on screen.

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Sorting ──────────────────────────────────────────────────────────
// For radio/select fields (e.g. Grade) we sort by the field's own options
// array so the order is natural, not alphabetical — otherwise "Grade 10"
// sorts before "Grade 2".

// Builds a single ORDER BY fragment for one field.
// Mutates `params` to append any new bind values; returns the SQL fragment.
function buildFieldSortClause(field, dir, params) {
  if (!UUID_REGEX.test(field.field_id)) {
    throw new Error('Invalid field_id format'); // should never happen — defensive
  }
  const direction = dir === 'desc' ? 'DESC' : 'ASC';

  if ((field.field_type === 'radio' || field.field_type === 'select') && Array.isArray(field.options) && field.options.length > 0) {
    // Natural sort using the form's option order
    params.push(field.options);
    return `array_position($${params.length}::text[], answers->>'${field.field_id}') ${direction} NULLS LAST`;
  }

  // Plain text comparison (works for text/email/phone/textarea/date)
  return `LOWER(answers->>'${field.field_id}') ${direction} NULLS LAST`;
}

// Heuristic: identify the "Grade" and "Name" fields for default CSV sort
function findGradeField(fields) {
  return fields.find(f =>
    (f.field_type === 'radio' || f.field_type === 'select') &&
    /grade|kindergarten/i.test(f.label || '')
  ) || null;
}

function findStudentNameField(fields) {
  return fields.find(f => /name of student/i.test(f.label || '')) || null;
}

// Builds the ORDER BY clause for submissions queries from an ordered list of
// sort specs (priority order). Each spec is { fieldId, dir } where fieldId is a
// field UUID or the special string 'submittedAt'.
// - useExportDefault: if true and no sorts given, sort by Grade ASC, Name ASC
// Returns { clause: string, params: array }
function buildSubmissionsSort(fields, sorts, useExportDefault) {
  const params = [];
  const list = Array.isArray(sorts) ? sorts : [];
  const fragments = [];
  let hasSubmittedAt = false;

  for (const s of list) {
    if (s.fieldId === 'submittedAt') {
      fragments.push(`submitted_at ${s.dir === 'asc' ? 'ASC' : 'DESC'}`);
      hasSubmittedAt = true;
      continue;
    }
    const field = fields.find(f => f.field_id === s.fieldId);
    if (field) {
      fragments.push(buildFieldSortClause(field, s.dir, params));
    }
  }

  if (fragments.length > 0) {
    // Append a stable secondary sort unless the user already sorts by date.
    const clause = hasSubmittedAt ? fragments.join(', ') : `${fragments.join(', ')}, submitted_at DESC`;
    return { clause, params };
  }

  if (useExportDefault) {
    const defFragments = [];
    const grade = findGradeField(fields);
    const name = findStudentNameField(fields);
    if (grade) defFragments.push(buildFieldSortClause(grade, 'asc', params));
    if (name) defFragments.push(buildFieldSortClause(name, 'asc', params));
    if (defFragments.length > 0) {
      return { clause: `${defFragments.join(', ')}, submitted_at DESC`, params };
    }
  }

  return { clause: 'submitted_at DESC', params };
}

// ─── Filtering ────────────────────────────────────────────────────────
// Submissions are filtered by status, submission date range, import state, and
// arbitrary per-field answer values. Field-value filters match against the
// JSONB answers keyed by field UUID. Choice fields match exactly (any of the
// selected values); text-ish fields match by case-insensitive "contains".

// Parse the multi-sort `sort` query param ("fieldId:dir,fieldId:dir"), falling
// back to the legacy single `sortFieldId`/`sortDir` params.
function parseSorts(query) {
  if (query.sort) {
    return String(query.sort)
      .split(',')
      .map(pair => {
        const [fieldId, dir] = pair.split(':');
        return { fieldId: (fieldId || '').trim(), dir: dir === 'desc' ? 'desc' : 'asc' };
      })
      .filter(s => s.fieldId);
  }
  if (query.sortFieldId) {
    return [{ fieldId: query.sortFieldId, dir: query.sortDir === 'desc' ? 'desc' : 'asc' }];
  }
  return [];
}

// Parse the `fieldFilters` query param (URL-encoded JSON array of
// { fieldId, values }). Returns [] on any malformed input.
function parseFieldFilters(query) {
  if (!query.fieldFilters) return [];
  try {
    const parsed = JSON.parse(query.fieldFilters);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(f => f && typeof f.fieldId === 'string' && Array.isArray(f.values))
      .map(f => ({ fieldId: f.fieldId, values: f.values.map(v => String(v)) }));
  } catch {
    return [];
  }
}

// Normalizes the `importState` query param. Anything unrecognized (including
// the explicit 'all') means "don't filter on import state".
function parseImportState(query) {
  const raw = query.importState;
  return raw === 'imported' || raw === 'not_imported' ? raw : null;
}

// Builds the WHERE body (excluding the leading "WHERE") for submissions queries.
// form_id is always bound to $1 by the caller; this returns the remaining bind
// values in order ($2, $3, ...). Used by the list, count, export, and import-scope
// queries so they stay consistent. Invalid/unknown field filters are silently skipped.
function buildSubmissionsWhere(fields, { status, dateFrom, dateTo, fieldFilters, importState }) {
  const params = [];
  const conds = ['form_id = $1'];
  let idx = 1; // $1 = form_id (supplied by caller)

  idx++; params.push(status || null);
  conds.push(`($${idx}::varchar IS NULL OR status = $${idx})`);

  idx++; params.push(dateFrom || null);
  conds.push(`($${idx}::timestamptz IS NULL OR submitted_at >= $${idx})`);

  idx++; params.push(dateTo || null);
  conds.push(`($${idx}::timestamptz IS NULL OR submitted_at <= $${idx})`);

  // Import state is a fixed enum resolved above, so it's safe to inline —
  // no user-supplied text reaches the SQL here.
  if (importState === 'imported') {
    conds.push('imported_student_id IS NOT NULL');
  } else if (importState === 'not_imported') {
    conds.push('imported_student_id IS NULL');
  }

  const fieldMap = new Map(fields.map(f => [f.field_id, f]));
  for (const ff of (fieldFilters || [])) {
    const field = fieldMap.get(ff.fieldId);
    if (!field || !UUID_REGEX.test(ff.fieldId)) continue; // skip unknown/malformed
    const values = (Array.isArray(ff.values) ? ff.values : [])
      .map(v => String(v))
      .filter(v => v !== '');
    if (values.length === 0) continue;

    if (field.field_type === 'select' || field.field_type === 'radio') {
      idx++; params.push(values);
      conds.push(`answers->>'${field.field_id}' = ANY($${idx}::text[])`);
    } else {
      const ors = values.map(v => {
        idx++; params.push(`%${v}%`);
        return `answers->>'${field.field_id}' ILIKE $${idx}`;
      });
      conds.push(`(${ors.join(' OR ')})`);
    }
  }

  return { clause: conds.join('\n        AND '), params };
}

module.exports = {
  UUID_REGEX,
  buildFieldSortClause,
  findGradeField,
  findStudentNameField,
  buildSubmissionsSort,
  parseSorts,
  parseFieldFilters,
  parseImportState,
  buildSubmissionsWhere,
};
