// services/analyticsEngine.js
//
// Orchestration layer for the teacher analytics feature.
//
// Design:
//   - ONE school-wide query (selectAnalyticsMatrix) per (school, term),
//     grouped in JS into a matrix of classes -> students -> score rows.
//   - The caller picks which grade engine computes each (student, class) %:
//       'null_skip' -> computeClassPctForStudent (studentViewEvaluator) —
//                      ungraded work is skipped; matches gradebook totals,
//                      student views, awards, and Al Haadi T2 report cards.
//       'null_zero' -> calculateStudentGrade (gradeCalculator) —
//                      ungraded work counts as 0; matches legacy T1 PDFs
//                      and the dashboard average.
//   - 5-minute in-memory cache per (school, term, engine). Scores change
//     during the school day, so this is deliberately much shorter than the
//     dashboard's 24h grade cache.

const db = require('../config/database');
const q = require('../queries/analytics.queries');
const { calculateStudentGrade } = require('../utils/gradeCalculator');
const { computeClassPctForStudent } = require('./studentViewEvaluator');

const VALID_ENGINES = ['null_skip', 'null_zero'];
const DEFAULT_ENGINE = 'null_skip';

// Sentinel termId meaning "every term combined". Classes are term-bound,
// so the combined matrix is the union of all terms' classes; a student's
// overall average then spans the whole year.
const ALL_TERMS = 'all';

const matrixCache = new Map(); // key `${school}:${termId}:${engine}` -> { matrix, timestamp }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function normalizeEngine(engine) {
  if (engine == null || engine === '') return DEFAULT_ENGINE;
  if (!VALID_ENGINES.includes(engine)) {
    const err = new Error(`Unknown grade engine '${engine}'. Expected one of: ${VALID_ENGINES.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  return engine;
}

/**
 * Compute one (student, class) percentage with the chosen engine.
 * Returns number for null_zero; number|null for null_skip (null = no
 * graded work in the class — callers must exclude it from aggregates,
 * never coerce to 0).
 */
function computePct(engine, assessments, studentRows) {
  if (engine === 'null_zero') {
    return calculateStudentGrade(
      assessments,
      studentRows.map((r) => ({
        assessment_id: r.assessment_id,
        score: r.score,
        is_excluded: r.is_excluded,
      })),
    );
  }
  return computeClassPctForStudent(assessments, studentRows);
}

/**
 * Missing / excluded counts for one student in one class, from their
 * score rows. "Missing" counts top-level assessments with no usable
 * grade: standalone with null score, or parent whose non-excluded
 * children are all null. Excluded assessments are never missing.
 */
function countWorkStatus(assessments, studentRows) {
  const lookup = {};
  for (const r of studentRows) {
    lookup[r.assessment_id] = { score: r.score, isExcluded: Boolean(r.is_excluded) };
  }

  let missing = 0;
  let excluded = 0;
  const missingAssessments = [];

  for (const a of assessments) {
    if (a.parent_assessment_id) continue; // top-level only
    const sd = lookup[a.assessment_id];
    if (sd?.isExcluded) {
      excluded += 1;
      continue;
    }
    if (a.is_parent) {
      const children = assessments.filter((c) => c.parent_assessment_id === a.assessment_id);
      const hasGradedChild = children.some((c) => {
        const csd = lookup[c.assessment_id];
        return csd && !csd.isExcluded && csd.score != null;
      });
      if (!hasGradedChild) {
        missing += 1;
        missingAssessments.push(a);
      }
    } else if (sd?.score == null) {
      missing += 1;
      missingAssessments.push(a);
    }
  }

  return { missing, excluded, missingAssessments };
}

/**
 * Group the flat SQL rows into the AnalyticsMatrix shape and run the
 * grade engine over every (student, class) pair.
 */
function buildMatrixFromRows(rows, termId, engine) {
  const classes = new Map(); // classId -> class record

  for (const r of rows) {
    let cls = classes.get(r.class_id);
    if (!cls) {
      cls = {
        classId: r.class_id,
        grade: r.class_grade,
        subject: r.subject,
        teacherName: r.teacher_name,
        termId: r.term_id,
        assessments: [],
        _assessmentIds: new Set(),
        students: new Map(),
      };
      classes.set(r.class_id, cls);
    }

    if (!cls._assessmentIds.has(r.assessment_id)) {
      cls._assessmentIds.add(r.assessment_id);
      cls.assessments.push({
        assessment_id: r.assessment_id,
        name: r.assessment_name,
        weight_percent: r.weight_percent,
        weight_points: r.weight_points,
        max_score: r.max_score,
        is_parent: r.is_parent,
        parent_assessment_id: r.parent_assessment_id,
        date: r.assessment_date,
        sort_order: r.sort_order,
      });
    }

    let stu = cls.students.get(r.student_id);
    if (!stu) {
      stu = {
        studentId: r.student_id,
        studentName: r.student_name,
        gradeLevel: r.student_grade,
        homeroomTeacherId: r.homeroom_teacher_id,
        rows: [],
      };
      cls.students.set(r.student_id, stu);
    }
    stu.rows.push(r);
  }

  // Run the grade engine + work-status counts per (student, class).
  const students = new Map(); // studentId -> cross-class record
  for (const cls of classes.values()) {
    delete cls._assessmentIds;
    for (const stu of cls.students.values()) {
      stu.finalPct = computePct(engine, cls.assessments, stu.rows);
      const ws = countWorkStatus(cls.assessments, stu.rows);
      stu.missingCount = ws.missing;
      stu.excludedCount = ws.excluded;
      stu.missingAssessments = ws.missingAssessments;

      let cross = students.get(stu.studentId);
      if (!cross) {
        cross = {
          studentId: stu.studentId,
          studentName: stu.studentName,
          gradeLevel: stu.gradeLevel,
          homeroomTeacherId: stu.homeroomTeacherId,
          classes: [],
        };
        students.set(stu.studentId, cross);
      }
      cross.classes.push({
        classId: cls.classId,
        subject: cls.subject,
        teacherName: cls.teacherName,
        grade: cls.grade,
        finalPct: stu.finalPct,
        missingCount: stu.missingCount,
        excludedCount: stu.excludedCount,
      });
    }
  }

  return { termId, engine, classes, students };
}

/**
 * Overall average across a student's classes: mean of non-null finalPcts.
 * Returns null when the student has no graded work anywhere.
 */
function overallAvgForStudent(crossRecord) {
  const pcts = crossRecord.classes.map((c) => c.finalPct).filter((p) => p != null);
  if (pcts.length === 0) return null;
  return pcts.reduce((s, p) => s + p, 0) / pcts.length;
}

/**
 * Fetch (or reuse cached) analytics matrix for a school + term + engine.
 */
async function buildAnalyticsMatrix(school, termId, engine) {
  const eng = normalizeEngine(engine);
  const key = `${school}:${termId}:${eng}`;
  const cached = matrixCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.matrix;
  }

  const { rows } =
    termId === ALL_TERMS
      ? await db.query(q.selectAnalyticsMatrixAllTerms, [school])
      : await db.query(q.selectAnalyticsMatrix, [school, termId]);
  const matrix = buildMatrixFromRows(rows, termId, eng);
  matrixCache.set(key, { matrix, timestamp: Date.now() });
  return matrix;
}

/**
 * Per-student attendance map for a term: studentId -> { presentDays, totalDays, pct }.
 */
async function getAttendanceMap(school, termId) {
  const { rows } =
    termId === ALL_TERMS
      ? await db.query(q.selectAttendanceAllTerms, [school])
      : await db.query(q.selectAttendanceForTerm, [termId, school]);
  const map = new Map();
  for (const r of rows) {
    map.set(r.student_id, {
      presentDays: r.present_days,
      totalDays: r.total_days,
      pct: r.attendance_pct == null ? null : parseFloat(r.attendance_pct),
    });
  }
  return map;
}

/**
 * Compact snapshot for AI features and the at-risk watchlist.
 * One record per student with overall avg, attendance, missing work and
 * weakest subject; plus grade/subject roll-ups.
 */
async function buildAiSnapshot(school, termId, engine) {
  const eng = normalizeEngine(engine);
  const [matrix, attendance] = await Promise.all([
    buildAnalyticsMatrix(school, termId, eng),
    getAttendanceMap(school, termId),
  ]);

  const studentRecords = [];
  for (const cross of matrix.students.values()) {
    const overallAvg = overallAvgForStudent(cross);
    const att = attendance.get(cross.studentId);
    const missingCount = cross.classes.reduce((s, c) => s + c.missingCount, 0);

    let lowest = null;
    for (const c of cross.classes) {
      if (c.finalPct == null) continue;
      if (!lowest || c.finalPct < lowest.finalPct) lowest = c;
    }

    studentRecords.push({
      studentId: cross.studentId,
      studentName: cross.studentName,
      gradeLevel: cross.gradeLevel,
      overallAvg: overallAvg == null ? null : Math.round(overallAvg * 10) / 10,
      attendancePct: att ? att.pct : null,
      missingCount,
      lowestSubject: lowest ? lowest.subject : null,
      lowestPct: lowest ? Math.round(lowest.finalPct * 10) / 10 : null,
      classCount: cross.classes.length,
    });
  }

  return { termId, engine: eng, students: studentRecords };
}

function invalidateCache(school, termId, engine) {
  if (school && termId && engine) {
    matrixCache.delete(`${school}:${termId}:${engine}`);
    return;
  }
  for (const key of matrixCache.keys()) {
    if (!school || key.startsWith(`${school}:`)) matrixCache.delete(key);
  }
}

module.exports = {
  buildAnalyticsMatrix,
  buildAiSnapshot,
  getAttendanceMap,
  overallAvgForStudent,
  invalidateCache,
  normalizeEngine,
  DEFAULT_ENGINE,
  VALID_ENGINES,
  ALL_TERMS,
  // exported for unit testing
  buildMatrixFromRows,
  countWorkStatus,
  computePct,
};
