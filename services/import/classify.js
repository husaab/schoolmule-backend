// services/import/classify.js
//
// Turns raw submissions + a saved field mapping into a decision per row:
// create a new entity, update an existing one, or skip.
//
// Pure and DB-free by design. Both preview and execute call `classifyBatch`
// with the same inputs, so what the admin approved in the preview is exactly
// what the import writes — they cannot drift, because it is one function.

const { buildCandidateIndex, resolveMatch } = require('./matching');

/**
 * Apply a form's saved mapping to one submission's answers.
 *
 * Returns { values, errors } where `values` is keyed by target field and
 * `errors` lists every reason this row cannot be imported. Errors are
 * collected rather than thrown so the admin sees all the problems with a
 * submission at once instead of fixing them one round-trip at a time.
 */
function mapAnswers(submission, mappings, target) {
  const values = {};
  const errors = [];
  const answers = submission.answers || {};

  for (const m of mappings) {
    const raw = answers[m.field_id];
    const result = target.coerceValue(m.target_field, raw, m.value_map);
    if (result.ok) {
      if (result.value !== null) values[m.target_field] = result.value;
    } else {
      errors.push({ targetField: m.target_field, message: result.error });
    }
  }

  // Required targets must be both mapped and non-empty, or there is nothing
  // to create. Reported against the target field so the message points at the
  // mapping, which is where the fix usually is.
  for (const def of target.mappableFields) {
    if (!def.required) continue;
    if (values[def.targetField] === undefined || values[def.targetField] === null) {
      const isMapped = mappings.some(m => m.target_field === def.targetField);
      errors.push({
        targetField: def.targetField,
        message: isMapped
          ? `${def.label} is empty in this submission`
          : `${def.label} is not mapped to a form field`,
      });
    }
  }

  return { values, errors };
}

/**
 * Classify every submission in the batch.
 *
 * @param submissions  raw submission rows (submission_id, answers, imported_student_id, ...)
 * @param mappings     saved mapping rows (field_id, target_field, value_map)
 * @param candidates   existing entity rows to match against
 * @param target       the import target adapter (studentImportTarget)
 * @param overrides    { [submissionId]: 'create' | 'update' | 'skip' } admin decisions
 * @param overrideMatchIds { [submissionId]: entityId } explicit match choice for
 *                     ambiguous rows, so an admin can say *which* existing record
 *                     to update when several were proposed.
 *
 * Decision table:
 *   already linked  → skip, and the override is ignored (undo the import first)
 *   validation error→ error, non-importable regardless of override
 *   exact match     → skip by default, override may promote to update/create
 *   near match      → needs review; unresolved rows stay skipped
 *   no match        → create by default, override may demote to skip
 */
function classifyBatch({
  submissions,
  mappings,
  candidates,
  target,
  overrides = {},
  overrideMatchIds = {},
}) {
  const index = buildCandidateIndex(candidates, target.getCandidateName);
  const candidateById = new Map(candidates.map(c => [target.getCandidateId(c), c]));
  const rows = [];

  for (const sub of submissions) {
    const { values, errors } = mapAnswers(sub, mappings, target);
    const override = overrides[sub.submission_id];

    const base = {
      submissionId: sub.submission_id,
      submittedAt: sub.submitted_at,
      values,
      mappedName: values.name ?? null,
      mappedGrade: values.grade ?? null,
      errors: errors.map(e => e.message),
      matchTier: 'none',
      matchedEntityId: null,
      matchedEntityName: null,
      matchCandidates: [],
      needsReview: false,
      diff: [],
    };

    // 1. Already imported. Terminal — the link must be undone before this
    //    submission can be imported again, so an override can't reopen it.
    if (sub.imported_student_id) {
      const existing = candidateById.get(sub.imported_student_id);
      rows.push({
        ...base,
        action: 'skip',
        matchTier: 'linked',
        matchedEntityId: sub.imported_student_id,
        matchedEntityName: existing ? target.getCandidateName(existing) : (sub.imported_student_name || null),
        reason: 'Already imported',
        locked: true,
      });
      continue;
    }

    // 2. Unmappable. Also terminal: no override can conjure a valid record.
    if (errors.length > 0) {
      rows.push({ ...base, action: 'error', reason: errors[0].message, locked: true });
      continue;
    }

    // 3. Match against what already exists.
    const { tier, matches } = resolveMatch(
      index,
      { name: values.name, grade: values.grade },
      target.getCandidateName,
      target.getCandidateGrade,
    );

    const matchCandidates = matches.map(c => ({
      entityId: target.getCandidateId(c),
      name: target.getCandidateName(c),
      grade: target.getCandidateGrade(c),
    }));

    // Which existing record an update would target: the admin's explicit pick
    // when they made one, otherwise the sole match.
    const pickedId = overrideMatchIds[sub.submission_id]
      || (matches.length === 1 ? target.getCandidateId(matches[0]) : null);
    const picked = pickedId ? candidateById.get(pickedId) : null;

    let action;
    let reason;
    let needsReview = false;

    if (tier === 'exact') {
      action = 'skip';
      reason = 'Already a student in this year';
    } else if (tier === 'near') {
      action = 'skip';
      needsReview = true;
      reason = matches.length > 1
        ? `Possible match — ${matches.length} similar students`
        : `Possible match — "${target.getCandidateName(matches[0])}" (grade ${target.getCandidateGrade(matches[0])})`;
    } else {
      action = 'create';
      reason = 'New student';
    }

    // The admin's decision wins over the default, but only between the three
    // real actions, and 'update' needs something to update.
    if (override === 'create' || override === 'skip' || override === 'update') {
      if (override === 'update' && !picked) {
        rows.push({
          ...base,
          action: 'error',
          matchTier: tier,
          matchCandidates,
          reason: 'Choose which existing student to update',
          needsReview: true,
        });
        continue;
      }
      action = override;
      reason = 'Chosen by admin';
      needsReview = false;
    }

    const diff = action === 'update' && picked ? target.diffFillable(picked, values) : [];

    // An update that would change nothing is a skip in everything but name;
    // say so rather than reporting a no-op as a successful update.
    if (action === 'update' && diff.length === 0) {
      rows.push({
        ...base,
        action: 'skip',
        matchTier: tier,
        matchedEntityId: pickedId,
        matchedEntityName: picked ? target.getCandidateName(picked) : null,
        matchCandidates,
        reason: 'Nothing to fill in — every mapped field already has a value',
      });
      continue;
    }

    rows.push({
      ...base,
      action,
      reason,
      needsReview,
      matchTier: tier,
      matchedEntityId: action === 'update' ? pickedId : (matches.length === 1 ? target.getCandidateId(matches[0]) : null),
      matchedEntityName: picked ? target.getCandidateName(picked) : (matches.length === 1 ? target.getCandidateName(matches[0]) : null),
      matchCandidates,
      diff,
    });
  }

  return { rows, summary: summarize(rows) };
}

function summarize(rows) {
  const summary = { create: 0, update: 0, skip: 0, error: 0, needsReview: 0, total: rows.length };
  for (const r of rows) {
    summary[r.action] = (summary[r.action] || 0) + 1;
    if (r.needsReview) summary.needsReview++;
  }
  return summary;
}

module.exports = { classifyBatch, mapAnswers, summarize };
