// services/classStats.js
//
// Who a class's statistics pool, and the pooled numbers themselves.
//
// A teacher can leave a student out of a class's pooled statistics
// (class_stats_exclusions): the class average, median, distribution, rank and
// percentile, and the per-assessment class averages. The student's own grade
// never changes: nothing here touches finalPct, coverage or work status.
//
// Every function that pools takes an explicit POOL:
//   POOL.COUNTED   the class's own figures, the ones every family and student sees
//   POOL.EVERYONE  every enrolled student; staff see it beside a counted figure
// Roll-ups above a class (subject, grade and school figures, the grade-cohort
// percentile) keep counting every student, and read everyonePcts().
//
// Pure: no DB access. The analytics matrix rows carry the stats_left_out_*
// flags (queries/analytics.queries.js) and attachLeftOut reads them.

const stats = require('../utils/statsUtils');
const { buildScoreLookup, computeAssessmentForStudent } = require('./gradeEngine');

const { isEffectivelyModified } = require('../utils/modifiedMark');

const POOL = Object.freeze({ COUNTED: 'counted', EVERYONE: 'everyone' });

function assertPool(pool) {
  if (pool !== POOL.COUNTED && pool !== POOL.EVERYONE) throw new Error(`Unknown statistics pool: ${pool}`);
}

/**
 * Tag every student of a class with what they're left out of, from the matrix
 * rows' flags: stu.leftOut = { wholeClass, assessmentIds: Set } or null. A
 * category left out covers its children; a child never covers its category.
 *
 * Also stu.modifiedIds: the columns a modified mark keeps this student out of,
 * its own column and the category holding it. That's kept apart from leftOut,
 * which is a teacher's decision and is shown as one ("2 left out").
 */
function attachLeftOut(cls) {
  const childrenOf = new Map();
  const parentOf = new Map();
  for (const a of cls.assessments) {
    if (!a.parent_assessment_id) continue;
    parentOf.set(a.assessment_id, a.parent_assessment_id);
    if (!childrenOf.has(a.parent_assessment_id)) childrenOf.set(a.parent_assessment_id, []);
    childrenOf.get(a.parent_assessment_id).push(a.assessment_id);
  }

  for (const stu of cls.students.values()) {
    let wholeClass = false;
    const assessmentIds = new Set();
    const modifiedIds = new Set();
    for (const r of stu.rows) {
      if (r.stats_left_out_class) wholeClass = true;
      if (isEffectivelyModified(r)) {
        modifiedIds.add(r.assessment_id);
        if (parentOf.has(r.assessment_id)) modifiedIds.add(parentOf.get(r.assessment_id));
      }
      if (!r.stats_left_out_assessment) continue;
      assessmentIds.add(r.assessment_id);
      for (const childId of childrenOf.get(r.assessment_id) || []) assessmentIds.add(childId);
    }
    stu.leftOut = wholeClass || assessmentIds.size > 0 ? { wholeClass, assessmentIds } : null;
    stu.modifiedIds = modifiedIds;
  }
}

/** Whether a teacher left this student out of the class, or of one assessment. */
function leftOutByTeacher(stu, assessmentId = null) {
  if (!stu.leftOut) return false;
  if (stu.leftOut.wholeClass) return true;
  return assessmentId != null && stu.leftOut.assessmentIds.has(assessmentId);
}

/**
 * Whether a student is in the pool for the class, or for one assessment. A
 * modified mark is on a different test, so it stays out of its own column; the
 * student's term grade still counts in the class's figures.
 */
function inPool(stu, pool, assessmentId = null) {
  assertPool(pool);
  if (pool === POOL.EVERYONE) return true;
  if (assessmentId != null && stu.modifiedIds?.has(assessmentId)) return false;
  return !leftOutByTeacher(stu, assessmentId);
}

/** How many students a teacher left out of the class, or of one assessment. */
function leftOutCount(cls, assessmentId = null) {
  let n = 0;
  for (const stu of cls.students.values()) if (leftOutByTeacher(stu, assessmentId)) n += 1;
  return n;
}

/** How many modified marks are out of this column's counted pool. */
function modifiedCount(cls, assessmentId) {
  let n = 0;
  for (const stu of cls.students.values()) if (stu.modifiedIds?.has(assessmentId)) n += 1;
  return n;
}

/** The term grades in a class's pool; students with no grade yet are skipped. */
function classPcts(cls, pool) {
  assertPool(pool);
  const pcts = [];
  for (const stu of cls.students.values()) {
    if (stu.finalPct != null && inPool(stu, pool)) pcts.push(stu.finalPct);
  }
  return pcts;
}

/** Every enrolled student's term grade: what roll-ups above a class pool. */
function everyonePcts(cls) {
  return classPcts(cls, POOL.EVERYONE);
}

/** The class average (1 dp), or null when nobody in the pool has a grade. */
function classAverage(cls, pool) {
  return stats.round1(stats.mean(classPcts(cls, pool)));
}

/** The class median (1 dp), or null when nobody in the pool has a grade. */
function classMedian(cls, pool) {
  return stats.round1(stats.median(classPcts(cls, pool)));
}

/**
 * Every assessment's pool: assessment_id -> { pcts, eligible }. pcts holds
 * the counted results (graded, or missing as 0) of the students in the pool:
 * score/max for a leaf, the graded roll-up for a category. eligible counts the
 * students in the pool whose cell isn't excused, for completion rates.
 */
function assessmentPools(cls, pool) {
  assertPool(pool);
  const out = new Map(cls.assessments.map((a) => [a.assessment_id, { pcts: [], eligible: 0 }]));
  for (const stu of cls.students.values()) {
    const lookup = buildScoreLookup(stu.rows);
    for (const a of cls.assessments) {
      if (!inPool(stu, pool, a.assessment_id)) continue;
      const r = computeAssessmentForStudent(a, cls.assessments, lookup);
      const entry = out.get(a.assessment_id);
      if (r.state !== 'excused') entry.eligible += 1;
      if (r.isCounted) entry.pcts.push(r.pct);
    }
  }
  return out;
}

/** assessment_id -> { avg (1 dp), n } for every assessment someone in the pool is graded on. */
function assessmentAverages(cls, pool) {
  const out = new Map();
  for (const [id, { pcts }] of assessmentPools(cls, pool)) {
    if (pcts.length > 0) out.set(id, { avg: stats.round1(stats.mean(pcts)), n: pcts.length });
  }
  return out;
}

/**
 * Rank and percentile in class, over the counted pool: studentId ->
 * { rank, percentile }. A student left out of the class, or with no grade
 * yet, has neither (null): "Not ranked".
 */
function rankInClass(cls) {
  const ranked = [...cls.students.values()]
    .filter((s) => s.finalPct != null && inPool(s, POOL.COUNTED))
    .sort((a, b) => b.finalPct - a.finalPct);
  const pcts = ranked.map((s) => s.finalPct);

  const out = new Map();
  for (const stu of cls.students.values()) out.set(stu.studentId, { rank: null, percentile: null });
  ranked.forEach((stu, idx) => {
    out.set(stu.studentId, { rank: idx + 1, percentile: stats.round1(stats.percentileRank(stu.finalPct, pcts)) });
  });
  return out;
}

module.exports = {
  POOL,
  attachLeftOut,
  inPool,
  leftOutCount,
  modifiedCount,
  classPcts,
  everyonePcts,
  classAverage,
  classMedian,
  assessmentPools,
  assessmentAverages,
  rankInClass,
};
