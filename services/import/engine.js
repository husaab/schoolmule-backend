// services/import/engine.js
//
// Orchestrates the submission → entity import: resolving which submissions are
// in scope, running the shared classification pass, and applying the writes.
//
// The engine knows nothing about students specifically — everything
// entity-shaped goes through the `target` adapter it is handed.
//
// Preview and execute both call `classifyBatch` with the same inputs. Execute
// re-derives the classification from current DB state inside its own
// transaction rather than trusting the preview payload, so a stale preview
// cannot cause a write the server would not have chosen on its own.

const importQueries = require('../../queries/registrationImport.queries');
const registrationQueries = require('../../queries/registration.queries');
const { classifyBatch } = require('./classify');
const { buildSubmissionsQuery, SUBMISSION_SELECT } = require('../submissionFilters');

// Hard ceiling on one import. Well above the largest real form (Al Haadi's
// biggest is 133) but low enough that a single transaction stays quick.
const MAX_IMPORT_ROWS = 1000;

/**
 * Resolve an import scope to concrete submission rows.
 *
 * scope is either
 *   { mode: 'selected', submissionIds: [...] }        — the checkbox selection
 *   { mode: 'filtered', status, dateFrom, dateTo, fieldFilters, importState }
 *                                                     — everything matching the
 *                                                       page's current filters
 *
 * Filtered mode goes through buildSubmissionsQuery, the exact same composer
 * the submissions list and CSV export use, so "import all matching filters"
 * operates on precisely the rows the admin is looking at.
 */
async function resolveScope(client, { formId, school, scope, fields }) {
  if (scope && scope.mode === 'selected') {
    const ids = Array.isArray(scope.submissionIds) ? scope.submissionIds : [];
    if (ids.length === 0) return [];
    const { rows } = await client.query(importQueries.selectSubmissionsByIds, [formId, school, ids]);
    return rows;
  }

  const { whereClause, orderClause, params, nextParamIndex } = buildSubmissionsQuery(
    formId,
    fields,
    {
      status: scope?.status,
      dateFrom: scope?.dateFrom,
      dateTo: scope?.dateTo,
      fieldFilters: scope?.fieldFilters,
      importState: scope?.importState,
    },
    scope?.sorts,
  );

  // One over the cap, so the caller can tell "exactly at the limit" from
  // "more than the limit" and warn instead of silently truncating.
  const sql = `
    SELECT ${SUBMISSION_SELECT}
    FROM registration_form_submissions
    WHERE ${whereClause}
    ORDER BY ${orderClause}
    LIMIT $${nextParamIndex}
  `;
  const { rows } = await client.query(sql, [...params, MAX_IMPORT_ROWS + 1]);
  return rows;
}

// Loads everything classification needs: the form's fields, its saved mapping,
// the submissions in scope, and the existing entities to match against.
async function loadContext(client, { formId, school, schoolYearId, scope, target }) {
  const { rows: fields } = await client.query(registrationQueries.selectFieldsByFormId, [formId]);
  const { rows: mappings } = await client.query(importQueries.selectMappingsByForm, [formId, school]);
  const submissions = await resolveScope(client, { formId, school, scope, fields });
  const candidates = await target.loadCandidates(client, { school, schoolYearId });
  return { fields, mappings, submissions, candidates };
}

/**
 * Dry run: classify the scope and report what would happen. Writes nothing.
 */
async function runPreview(db, { formId, school, schoolYearId, scope, overrides, overrideMatchIds, target }) {
  const client = await db.connect();
  try {
    const ctx = await loadContext(client, { formId, school, schoolYearId, scope, target });

    if (ctx.mappings.length === 0) {
      return { needsMapping: true, rows: [], summary: null, truncated: false };
    }
    const truncated = ctx.submissions.length > MAX_IMPORT_ROWS;
    const submissions = truncated ? ctx.submissions.slice(0, MAX_IMPORT_ROWS) : ctx.submissions;

    const { rows, summary } = classifyBatch({
      submissions,
      mappings: ctx.mappings,
      candidates: ctx.candidates,
      target,
      overrides,
      overrideMatchIds,
    });

    return { needsMapping: false, rows, summary, truncated, maxRows: MAX_IMPORT_ROWS };
  } finally {
    client.release();
  }
}

/**
 * Apply the import in a single transaction.
 *
 * Only the admin's decisions (`overrides` / `overrideMatchIds`) come from the
 * client. Mapped values, validation and matching are all recomputed here, so a
 * preview that has gone stale degrades into a reported error rather than a bad
 * write.
 */
async function runExecute(db, {
  formId, school, schoolYearId, userId, scope, overrides, overrideMatchIds, sideEffects, target,
}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const ctx = await loadContext(client, { formId, school, schoolYearId, scope, target });
    if (ctx.mappings.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'NO_MAPPING', message: 'Configure the student field mapping for this form first' };
    }
    if (ctx.submissions.length > MAX_IMPORT_ROWS) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        code: 'TOO_MANY',
        message: `This import covers ${ctx.submissions.length} submissions; the maximum per run is ${MAX_IMPORT_ROWS}. Narrow the filters and import in smaller batches.`,
      };
    }

    const { rows: classified } = classifyBatch({
      submissions: ctx.submissions,
      mappings: ctx.mappings,
      candidates: ctx.candidates,
      target,
      overrides,
      overrideMatchIds,
    });

    const results = [];
    const createdStudents = [];
    const updatedStudents = [];

    for (const row of classified) {
      if (row.action === 'skip') {
        results.push({ submissionId: row.submissionId, action: 'skip', reason: row.reason });
        continue;
      }
      if (row.action === 'error') {
        results.push({ submissionId: row.submissionId, action: 'error', reason: row.reason });
        continue;
      }

      if (row.action === 'create') {
        const student = await target.applyCreate(client, row.values, {
          school,
          schoolYearId,
          submissionId: row.submissionId,
          homeroomTeacherId: sideEffects?.homeroomTeacherId,
        });

        // Claim the submission. Zero rows means a concurrent import already
        // took it, so roll this one student back out rather than leaving an
        // orphan that no submission points at.
        const { rows: claimed } = await client.query(importQueries.markSubmissionImported, [
          row.submissionId, student.student_id, userId, school,
        ]);
        if (claimed.length === 0) {
          await client.query(importQueries.deleteStudentScoped, [student.student_id, school]);
          results.push({
            submissionId: row.submissionId,
            action: 'skip',
            reason: 'Imported by someone else while this import was running',
          });
          continue;
        }

        createdStudents.push(student);
        results.push({
          submissionId: row.submissionId, action: 'create',
          studentId: student.student_id, studentName: student.name,
        });
        continue;
      }

      if (row.action === 'update') {
        // Claim the submission BEFORE writing. A create has to write first
        // (there is no student id to claim with until the row exists, hence the
        // delete-on-loss above), but an update already knows its target, so
        // claiming first means a lost race writes nothing at all rather than
        // leaving fields changed by an import that reports itself as skipped.
        const { rows: claimed } = await client.query(importQueries.markSubmissionImported, [
          row.submissionId, row.matchedEntityId, userId, school,
        ]);
        if (claimed.length === 0) {
          results.push({
            submissionId: row.submissionId,
            action: 'skip',
            reason: 'Imported by someone else while this import was running',
          });
          continue;
        }

        const updated = await target.applyUpdate(client, row.matchedEntityId, row.diff);
        if (!updated) {
          // Nothing to write after all — release the claim so the submission
          // isn't left marked as imported by a no-op.
          await client.query(importQueries.clearSubmissionImport, [row.submissionId, school]);
          results.push({ submissionId: row.submissionId, action: 'skip', reason: 'Nothing left to fill in' });
          continue;
        }
        await client.query(importQueries.setStudentSourceSubmission, [updated.student_id, row.submissionId]);

        updatedStudents.push(updated);
        results.push({
          submissionId: row.submissionId, action: 'update',
          studentId: updated.student_id, studentName: updated.name,
          fieldsFilled: row.diff.map(d => d.label),
        });
      }
    }

    // ─── Optional batch side effects ──────────────────────────────────
    const touched = [...createdStudents, ...updatedStudents];
    const effects = { homeroomAssigned: 0, enrollments: 0 };

    if (sideEffects?.homeroomTeacherId && touched.length > 0) {
      // Creates already carry the teacher; this covers the updated students.
      const ids = updatedStudents.map(s => s.student_id);
      if (ids.length > 0) {
        await target.sideEffects.assignHomeroomTeacher(client, ids, sideEffects.homeroomTeacherId);
      }
      effects.homeroomAssigned = touched.length;
    }

    if (sideEffects?.autoEnroll && touched.length > 0) {
      effects.enrollments = await target.sideEffects.enrollInGradeClasses(client, touched, {
        school, schoolYearId,
      });
    }

    await client.query('COMMIT');

    return {
      ok: true,
      results,
      effects,
      summary: {
        created: createdStudents.length,
        updated: updatedStudents.length,
        skipped: results.filter(r => r.action === 'skip').length,
        errored: results.filter(r => r.action === 'error').length,
        total: results.length,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reverse an import.
 *
 * Always unlinks. Deletes the created entity only when explicitly asked AND
 * nothing depends on it — most of the tables referencing a student cascade on
 * delete, so an unchecked delete would silently take attendance, grades and
 * report card feedback with it.
 */
async function runUndo(db, { submissionId, school, deleteStudent, target }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(importQueries.selectSubmissionForUndo, [submissionId, school]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'NOT_FOUND', message: 'Submission not found' };
    }
    const submission = rows[0];
    if (!submission.imported_student_id) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'NOT_IMPORTED', message: 'This submission has not been imported' };
    }

    const studentId = submission.imported_student_id;
    const blockedBy = deleteStudent ? await findDependents(client, studentId, target) : [];

    await client.query(importQueries.clearSubmissionImport, [submissionId, school]);
    await client.query(importQueries.clearStudentSourceSubmission, [studentId]);

    let studentDeleted = false;
    if (deleteStudent && blockedBy.length === 0) {
      const { rows: deleted } = await client.query(importQueries.deleteStudentScoped, [studentId, school]);
      studentDeleted = deleted.length > 0;
    }

    await client.query('COMMIT');
    return {
      ok: true,
      unlinked: true,
      studentDeleted,
      blockedBy,
      studentId,
      studentName: submission.imported_student_name,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Which of the target's dependent tables hold rows for this entity.
 * Reported to the admin so "can't delete" comes with a reason.
 */
async function findDependents(client, entityId, target) {
  const found = [];
  for (const dep of target.dependentTables) {
    const { rows } = await client.query(
      `SELECT 1 FROM ${dep.table} WHERE ${dep.column} = $1 LIMIT 1`,
      [entityId],
    );
    if (rows.length > 0) found.push({ table: dep.table, label: dep.label });
  }
  return found;
}

/**
 * Read-only dependent check, for showing the undo dialog the right options
 * before the admin commits to anything.
 */
async function inspectUndo(db, { submissionId, school, target }) {
  const { rows } = await db.query(importQueries.selectSubmissionForUndo, [submissionId, school]);
  if (rows.length === 0) return { ok: false, code: 'NOT_FOUND', message: 'Submission not found' };
  const submission = rows[0];
  if (!submission.imported_student_id) {
    return { ok: false, code: 'NOT_IMPORTED', message: 'This submission has not been imported' };
  }

  const client = await db.connect();
  try {
    const blockedBy = await findDependents(client, submission.imported_student_id, target);
    return {
      ok: true,
      studentId: submission.imported_student_id,
      studentName: submission.imported_student_name,
      blockedBy,
      canDelete: blockedBy.length === 0,
    };
  } finally {
    client.release();
  }
}

module.exports = { runPreview, runExecute, runUndo, inspectUndo, resolveScope, MAX_IMPORT_ROWS };
