// services/analyticsEngine.js
//
// Orchestration layer for the teacher analytics feature.
//
// Design:
//   - ONE school-wide query (selectAnalyticsMatrix) per (school, term),
//     grouped in JS into a matrix of classes -> students -> score rows.
//   - Every (student, class) % comes from services/gradeEngine.js — the one
//     engine the gradebook, report cards, parent portal and emails share.
//     A blank cell carries no weight, "missing" counts as 0, "excused" is
//     ignored, and a student with no evidence has a null pct (never 0).
//   - 5-minute in-memory cache per (school, term, publishedOnly). Scores
//     change during the school day, so this is deliberately much shorter
//     than the dashboard's 24h grade cache.
//
// `engine` parameters are still accepted everywhere for backwards
// compatibility with older clients but are ignored; responses report
// engine: 'graded_only'.

const db = require('../config/database');
const q = require('../queries/analytics.queries');
const stats = require('../utils/statsUtils');
const gradeEngine = require('./gradeEngine');
const { computeClassGrade, computeAssessmentForStudent, buildScoreLookup } = gradeEngine;

const ENGINE_NAME = 'graded_only';
const VALID_ENGINES = [ENGINE_NAME];
const DEFAULT_ENGINE = ENGINE_NAME;

// Sentinel termId meaning "every term combined". Classes are term-bound,
// so the combined matrix is the union of all terms' classes; a student's
// overall average then spans the whole year.
const ALL_TERMS = 'all';

const matrixCache = new Map(); // key `${school}:${termId}:${engine}` -> { matrix, timestamp }
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function normalizeEngine() {
  // Legacy null_skip / null_zero selectors are ignored: there is one engine.
  return ENGINE_NAME;
}

/**
 * One (student, class) result from the shared engine:
 * { pct: number|null, coverage, missingAssessments }.
 */
function computeGrade(assessments, studentRows) {
  return computeClassGrade(assessments, studentRows);
}

/**
 * Work-status counts for one student in one class.
 *   missing       cells the teacher flagged missing (count as 0)
 *   excused       cells excused (never count)
 *   notYetGraded  blank cells (no evidence yet)
 *   missingAssessments  the flagged-missing leaf assessments
 */
function countWorkStatus(assessments, studentRows) {
  const { coverage, missingAssessments } = computeClassGrade(assessments, studentRows);
  return {
    missing: coverage.missing,
    excused: coverage.excused,
    excluded: coverage.excused,
    notYetGraded: coverage.blank,
    missingAssessments,
    coverage,
  };
}

/**
 * Prune one class down to the assessments a parent is allowed to see.
 *
 * Visible = published assessments ∪ categories with ≥1 published child.
 *
 * That second clause is load-bearing, not a nicety. Both grade engines
 * reach a category's children only by first finding the category in the
 * top-level list (`filter(a => !a.parent_assessment_id)`) and then
 * filtering children off it. Drop a category whose child is published and
 * that child becomes structurally unreachable — it silently vanishes from
 * finalPct AND from countWorkStatus, with no error anywhere. Keeping the
 * category also gives partial category publishing for free: the rollup is
 * computed from just the published children's weights.
 *
 * Pruning happens BEFORE computePct/countWorkStatus run, so the class
 * percentage is genuinely recomputed over the published subset rather
 * than display-filtered. Both engines normalise by the sum of weights in
 * the array they are handed, so neither needs to know this happened.
 */
function prunePublishedOnly(cls) {
  const publishedIds = new Set(
    cls.assessments.filter((a) => a.is_published).map((a) => a.assessment_id),
  );
  const visibleIds = new Set(publishedIds);

  for (const a of cls.assessments) {
    if (!a.is_parent) continue;
    const hasPublishedChild = cls.assessments.some(
      (c) => c.parent_assessment_id === a.assessment_id && publishedIds.has(c.assessment_id),
    );
    if (hasPublishedChild) visibleIds.add(a.assessment_id);
  }

  cls.assessments = cls.assessments.filter((a) => visibleIds.has(a.assessment_id));
  for (const stu of cls.students.values()) {
    stu.rows = stu.rows.filter((r) => visibleIds.has(r.assessment_id));
  }
}

/**
 * Group the flat SQL rows into the AnalyticsMatrix shape and run the
 * grade engine over every (student, class) pair.
 *
 * publishedOnly restricts the matrix to parent-visible work (see
 * prunePublishedOnly). It is opt-in: teacher analytics, the admin
 * dashboard and report cards pass nothing and get the full matrix,
 * unchanged.
 */
function buildMatrixFromRows(rows, termId, _engine, { publishedOnly = false } = {}) {
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
        is_published: r.is_published,
        parent_comment: r.parent_comment,
        published_at: r.published_at,
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
    if (publishedOnly) prunePublishedOnly(cls);
    for (const stu of cls.students.values()) {
      const result = computeGrade(cls.assessments, stu.rows);
      stu.finalPct = result.pct;
      stu.coverage = result.coverage;
      stu.missingCount = result.coverage.missing;
      stu.excludedCount = result.coverage.excused;
      stu.notYetGradedCount = result.coverage.blank;
      stu.missingAssessments = result.missingAssessments;

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
        coverage: stu.coverage,
        missingCount: stu.missingCount,
        excludedCount: stu.excludedCount,
        notYetGradedCount: stu.notYetGradedCount,
      });
    }
  }

  return { termId, engine: ENGINE_NAME, classes, students };
}

/**
 * One student's full per-class breakdown, in API shape.
 *
 * Extracted from parentPortal.controller so the parent grades endpoint and
 * the AI weekly summary read identical numbers from one implementation.
 *
 * Category (is_parent) rows carry rollupPct — their weighted average over
 * graded children — computed by the shared null-skip helper rather than
 * re-derived. Without it a category row looks ungraded (categories have no
 * student_assessments row of their own, so score is always null) and reads
 * as missing work to a parent.
 *
 * Returns null when the student is not in the matrix at all.
 */
/**
 * Class-wide average per assessment, so a parent can read a mark against the
 * room: the mean of peers' score/max for leaves, and of peers' graded rollups
 * for categories. Excluded and ungraded peers are skipped. Runs over the
 * class's current rows, so on a published-only matrix unpublished peers can't
 * leak in. Keyed by assessment_id; missing when nobody is graded.
 */
function classAveragesByAssessment(cls) {
  const sums = new Map();
  const add = (id, pct) => {
    const s = sums.get(id) || { total: 0, n: 0 };
    s.total += pct;
    s.n += 1;
    sums.set(id, s);
  };

  for (const stu of cls.students.values()) {
    const lookup = buildScoreLookup(stu.rows);
    for (const a of cls.assessments) {
      const r = computeAssessmentForStudent(a, cls.assessments, lookup);
      if (r.isCounted) add(a.assessment_id, r.pct);
    }
  }

  const averages = new Map();
  for (const [id, { total, n }] of sums) averages.set(id, stats.round1(total / n));
  return averages;
}

function getStudentClassBreakdown(matrix, studentId) {
  const cross = matrix.students.get(studentId);
  if (!cross) return null;

  const classes = [];
  const missingWork = [];

  for (const enrolled of cross.classes) {
    const cls = matrix.classes.get(enrolled.classId);
    const stu = cls.students.get(studentId);
    const scoreLookup = buildScoreLookup(stu.rows);
    const byId = new Map(cls.assessments.map((a) => [a.assessment_id, a]));
    const classAvgByAssessment = classAveragesByAssessment(cls);

    // Mean of the class's non-null finalPcts (null-skip aware).
    const peerPcts = [...cls.students.values()].map((s) => s.finalPct).filter((p) => p != null);

    classes.push({
      classId: cls.classId,
      subject: cls.subject,
      teacherName: cls.teacherName,
      finalPct: stats.round1(stu.finalPct),
      classAvg: peerPcts.length ? stats.round1(stats.mean(peerPcts)) : null,
      coverage: stu.coverage,
      missingCount: stu.missingCount,
      excludedCount: stu.excludedCount,
      notYetGradedCount: stu.notYetGradedCount,
      assessmentScores: stu.rows.map((r) => {
        const assessment = byId.get(r.assessment_id);
        const isParent = Boolean(r.is_parent);
        const rollup =
          isParent && assessment
            ? computeAssessmentForStudent(assessment, cls.assessments, scoreLookup)
            : null;
        const state = isParent
          ? (rollup ? rollup.state : 'blank')
          : (scoreLookup[r.assessment_id]?.state || 'blank');

        return {
          status: state,
          assessmentId: r.assessment_id,
          name: r.assessment_name,
          date: r.assessment_date,
          score: r.score == null ? null : parseFloat(r.score),
          maxScore: r.max_score == null ? null : parseFloat(r.max_score),
          weightPoints: r.weight_points == null ? null : parseFloat(r.weight_points),
          isExcluded: Boolean(r.is_excluded),
          isParent,
          parentAssessmentId: r.parent_assessment_id,
          // Categories have no raw score — this is their weighted rollup
          // over graded children, or null when none are graded yet.
          rollupPct: rollup && rollup.isCounted ? stats.round1(rollup.pct) : null,
          // The room's mean on this one assessment, for context next to the mark.
          classAvgPct: classAvgByAssessment.get(r.assessment_id) ?? null,
          parentComment: r.parent_comment || null,
          publishedAt: r.published_at || null,
        };
      }),
    });

    for (const a of stu.missingAssessments) {
      missingWork.push({
        classId: cls.classId,
        subject: cls.subject,
        assessmentId: a.assessment_id,
        assessmentName: a.name,
        assessmentDate: a.date,
        weightPoints: a.weight_points == null ? null : parseFloat(a.weight_points),
        isParent: Boolean(a.is_parent),
      });
    }
  }

  return {
    studentId: cross.studentId,
    studentName: cross.studentName,
    gradeLevel: cross.gradeLevel,
    overallAvg: overallAvgForStudent(cross),
    classes,
    missingWork,
  };
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
 *
 * publishedOnly (parent portal only) restricts the matrix to assessments
 * teachers have published, and is cached separately from the full matrix
 * so the two never bleed into each other.
 */
async function buildAnalyticsMatrix(school, termId, engine, { publishedOnly = false } = {}) {
  const eng = normalizeEngine(engine);
  const key = `${school}:${termId}:${publishedOnly ? 'pub' : 'all'}`;
  const cached = matrixCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.matrix;
  }

  const { rows } =
    termId === ALL_TERMS
      ? await db.query(q.selectAnalyticsMatrixAllTerms, [school])
      : await db.query(q.selectAnalyticsMatrix, [school, termId]);
  const matrix = buildMatrixFromRows(rows, termId, eng, { publishedOnly });
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
    const notYetGradedCount = cross.classes.reduce((s, c) => s + (c.notYetGradedCount || 0), 0);

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
      notYetGradedCount,
      lowestSubject: lowest ? lowest.subject : null,
      lowestPct: lowest ? Math.round(lowest.finalPct * 10) / 10 : null,
      classCount: cross.classes.length,
    });
  }

  return { termId, engine: eng, students: studentRecords };
}

function invalidateCache(school, termId) {
  if (school && termId) {
    // Both variants: the parent portal has its own published-only matrix.
    matrixCache.delete(`${school}:${termId}:all`);
    matrixCache.delete(`${school}:${termId}:pub`);
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
  getStudentClassBreakdown,
  invalidateCache,
  normalizeEngine,
  DEFAULT_ENGINE,
  VALID_ENGINES,
  ALL_TERMS,
  ENGINE_NAME,
  // exported for unit testing
  buildMatrixFromRows,
  countWorkStatus,
  computeGrade,
  prunePublishedOnly,
};
