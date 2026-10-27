// controllers/classStatsExclusions.controller.js
//
// Students left out of a class's pooled statistics: the class average,
// median, rank and the per-assessment class averages (services/classStats.js).
// Their own marks never change. Staff only; a family never learns who is
// left out.
//
//   GET    /api/classes/:classId/stats-exclusions
//   PUT    /api/classes/:classId/stats-exclusions/:studentId
//          { scope: 'class' | 'assessments', assessmentIds?, note? }
//          replaces everything that student is left out of, in one go
//   DELETE /api/classes/:classId/stats-exclusions/:studentId   counts them again
//   GET    /api/analytics/stats-exclusions?termId=             the school's list

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/classStatsExclusions.queries');
const engine = require('../services/analyticsEngine');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES = ['class', 'assessments'];
const NOTE_MAX = 500;

/**
 * Group exclusion rows into one entry per (class, student). Every row of a
 * student carries the same note and author, because a save replaces them all.
 */
function toEntries(rows) {
  const entries = new Map();
  for (const r of rows) {
    const key = `${r.class_id}|${r.student_id}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        classId: r.class_id,
        studentId: r.student_id,
        scope: 'assessments',
        assessmentIds: [],
        note: r.note ?? null,
        createdBy: r.created_by ?? null,
        createdByName: r.created_by_name || null,
        createdAt: r.created_at,
        ...(r.student_name !== undefined && {
          studentName: r.student_name,
          subject: r.subject,
          grade: r.grade,
          termId: r.term_id,
          teacherName: r.teacher_name || null,
          assessmentNames: [],
        }),
      };
      entries.set(key, entry);
    }
    if (r.assessment_id == null) {
      entry.scope = 'class';
    } else {
      entry.assessmentIds.push(r.assessment_id);
      if (entry.assessmentNames && r.assessment_name) entry.assessmentNames.push(r.assessment_name);
    }
  }
  // A whole-class row wins: per-assessment rows are never saved beside one.
  for (const entry of entries.values()) {
    if (entry.scope === 'class') {
      entry.assessmentIds = [];
      if (entry.assessmentNames) entry.assessmentNames = [];
    }
  }
  return [...entries.values()];
}

/** The body of a PUT, or { error } with the message for a 400. */
function parseBody(body) {
  const { scope, assessmentIds, note } = body || {};
  if (!SCOPES.includes(scope)) return { error: "scope must be 'class' or 'assessments'" };

  let cleanNote = null;
  if (note != null) {
    if (typeof note !== 'string') return { error: 'note must be text' };
    cleanNote = note.trim() || null;
    if (cleanNote && cleanNote.length > NOTE_MAX) return { error: `Keep the note under ${NOTE_MAX} characters` };
  }

  if (scope === 'class') return { scope, assessmentIds: [], note: cleanNote };

  if (!Array.isArray(assessmentIds) || assessmentIds.length === 0) {
    return { error: 'Choose at least one assessment to leave them out of' };
  }
  if (assessmentIds.some((id) => typeof id !== 'string' || !UUID_RE.test(id))) {
    return { error: 'assessmentIds must be assessment ids' };
  }
  return { scope, assessmentIds: [...new Set(assessmentIds)], note: cleanNote };
}

const list = async (req, res) => {
  try {
    const { rows } = await db.query(q.selectForClass, [req.params.classId]);
    return res.status(200).json({ status: 'success', data: toEntries(rows) });
  } catch (err) {
    logger.error(err);
    return res.status(500).json({ status: 'failed', message: 'Error loading who counts in the class average' });
  }
};

const put = async (req, res) => {
  const { classId, studentId } = req.params;
  if (!UUID_RE.test(studentId || '')) {
    return res.status(400).json({ status: 'failed', message: 'studentId must be a student id' });
  }
  const parsed = parseBody(req.body);
  if (parsed.error) return res.status(400).json({ status: 'failed', message: parsed.error });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const enrolled = await client.query(q.selectEnrolment, [classId, studentId]);
    if (enrolled.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ status: 'failed', message: "This student isn't in this class" });
    }

    if (parsed.scope === 'assessments') {
      const found = await client.query(q.selectClassAssessmentIds, [classId, parsed.assessmentIds]);
      if (found.rows.length !== parsed.assessmentIds.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ status: 'failed', message: 'Every assessment must belong to this class' });
      }
    }

    const userId = req.user?.userId ?? null;
    await client.query(q.deleteForStudent, [classId, studentId]);
    if (parsed.scope === 'class') {
      await client.query(q.insertWholeClass, [classId, studentId, parsed.note, userId]);
    } else {
      await client.query(q.insertAssessments, [classId, studentId, parsed.assessmentIds, parsed.note, userId]);
    }
    const { rows } = await client.query(q.selectForStudent, [classId, studentId]);
    await client.query('COMMIT');

    engine.invalidateCache(req.user.school);
    return res.status(200).json({ status: 'success', data: toEntries(rows)[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error(err);
    return res.status(500).json({ status: 'failed', message: "Couldn't save who counts in the class average" });
  } finally {
    client.release();
  }
};

const remove = async (req, res) => {
  const { classId, studentId } = req.params;
  if (!UUID_RE.test(studentId || '')) {
    return res.status(400).json({ status: 'failed', message: 'studentId must be a student id' });
  }
  try {
    await db.query(q.deleteForStudent, [classId, studentId]);
    engine.invalidateCache(req.user.school);
    return res.status(200).json({ status: 'success' });
  } catch (err) {
    logger.error(err);
    return res.status(500).json({ status: 'failed', message: "Couldn't count this student again" });
  }
};

/** The school's exclusions for a term (?termId=, or 'all'), for admins. */
const listForSchool = async (req, res) => {
  const { termId } = req.query;
  if (!termId) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: termId' });
  }
  if (termId !== engine.ALL_TERMS && !UUID_RE.test(termId)) {
    return res.status(400).json({ status: 'failed', message: 'termId must be a term id' });
  }
  try {
    const { rows } = await db.query(q.selectForSchoolTerm, [
      req.user.school,
      termId === engine.ALL_TERMS ? null : termId,
    ]);
    return res.status(200).json({ status: 'success', data: toEntries(rows) });
  } catch (err) {
    logger.error(err);
    return res.status(500).json({ status: 'failed', message: 'Error loading students left out of class averages' });
  }
};

module.exports = { list, put, remove, listForSchool, toEntries };
