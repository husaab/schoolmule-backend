// services/gradeEngine.js
//
// THE grade engine. Every percentage anyone sees — gradebook, report cards,
// parent portal, analytics, emails, Excel — comes from here. There is a
// line-for-line TypeScript port at schoolmule/src/lib/gradeEngine.ts used
// for the live grid preview; change both together.
//
// Rule (decided 2026-10-10, see docs/superpowers/specs/2026-10-10-non-zero-grading-design.md):
//   A student's grade is the weighted average of the assessments that have
//   EVIDENCE, scaled to the weight of those assessments only. Evidence is a
//   score (0 included) or a deliberate "missing" flag (counts as 0). A blank
//   cell is "not yet graded" and carries no weight. An excused cell never
//   counts. A student with no evidence at all has no grade (null), never 0.
//
// Cell states, resolved from a student_assessments row:
//   blank    no row, or score null with status 'graded'   -> not counted
//   graded   score not null, status 'graded'              -> counted, score/max
//   missing  status 'missing'                             -> counted as 0
//   excused  status 'excused'                             -> not counted
//
// Categories (is_parent) roll up their counted children by child weight.
// A category with no counted children is not counted.

const CELL_STATES = ['blank', 'graded', 'missing', 'excused'];
const STATUSES = ['graded', 'missing', 'excused'];

function toNum(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Resolve a score row to one of CELL_STATES. Accepts legacy is_excluded. */
function cellState(row) {
  if (!row) return 'blank';
  const status = row.status || (row.is_excluded ? 'excused' : 'graded');
  if (status === 'excused') return 'excused';
  if (status === 'missing') return 'missing';
  return row.score == null ? 'blank' : 'graded';
}

/**
 * { assessment_id -> { score, state } } for one student's rows. Exported so
 * callers evaluating several assessments for the same student build it once.
 */
function buildScoreLookup(rows) {
  const lookup = {};
  for (const row of rows || []) {
    lookup[row.assessment_id] = {
      score: row.score == null ? null : parseFloat(row.score),
      state: cellState(row),
    };
  }
  return lookup;
}

/**
 * One top-level assessment's result for one student.
 *
 * Returns:
 *   state     'graded' | 'missing' | 'excused' | 'blank'. For a category:
 *             'graded' when any child counts, 'excused' when every child is
 *             excused, otherwise 'blank'.
 *   isCounted whether this assessment contributes weight to the class total.
 *   pct       0-100 when counted, else null.
 *   earned/max raw points for a standalone (missing -> 0/max); null for a
 *             category, which has only a weighted rollup.
 *   weight    this assessment's weight_points.
 */
function computeAssessmentForStudent(assessment, allAssessments, scoreLookup) {
  const weight = toNum(assessment.weight_points, 0);
  const notCounted = (state) => ({ state, isCounted: false, pct: null, earned: null, max: null, weight });

  if (assessment.is_parent) {
    const children = allAssessments.filter(
      (c) => c.parent_assessment_id === assessment.assessment_id,
    );
    let earned = 0;
    let countedWeight = 0;
    let excusedChildren = 0;
    for (const c of children) {
      const sd = scoreLookup[c.assessment_id];
      const state = sd ? sd.state : 'blank';
      if (state === 'excused') { excusedChildren += 1; continue; }
      if (state === 'blank') continue;
      const max = toNum(c.max_score, 0) || 100;
      const cw = toNum(c.weight_points, 0);
      const pct = state === 'missing' ? 0 : Math.min(sd.score / max, 1);
      earned += pct * cw;
      countedWeight += cw;
    }
    if (countedWeight === 0) {
      return notCounted(children.length > 0 && excusedChildren === children.length ? 'excused' : 'blank');
    }
    return { state: 'graded', isCounted: true, pct: (earned / countedWeight) * 100, earned: null, max: null, weight };
  }

  const sd = scoreLookup[assessment.assessment_id];
  const state = sd ? sd.state : 'blank';
  if (state === 'blank' || state === 'excused') return notCounted(state);
  const max = toNum(assessment.max_score, 0) || 100;
  if (state === 'missing') {
    return { state, isCounted: true, pct: 0, earned: 0, max, weight };
  }
  return { state, isCounted: true, pct: (sd.score / max) * 100, earned: sd.score, max, weight };
}

/**
 * A student's grade in one class.
 *
 * @param {Array} assessments  every assessment in the class (parents + children)
 * @param {Array} rows         that student's score rows ({assessment_id, score, status})
 * @returns {{ pct: number|null, coverage: object, missingAssessments: Array }}
 *   pct       weighted average over counted top-level assessments, or null
 *             when nothing counts (no evidence).
 *   coverage  leaf-level counts: { assessed, graded, missing, excused, blank,
 *             total, countedWeight, totalWeight }. "assessed" = graded + missing.
 *   missingAssessments  leaf assessments flagged missing (for work lists).
 */
function computeClassGrade(assessments, rows) {
  const lookup = buildScoreLookup(rows);
  const topLevel = assessments.filter((a) => !a.parent_assessment_id);

  let earned = 0;
  let countedWeight = 0;
  let totalWeight = 0;
  for (const a of topLevel) {
    const r = computeAssessmentForStudent(a, assessments, lookup);
    totalWeight += r.weight;
    if (!r.isCounted) continue;
    earned += (r.pct * r.weight) / 100;
    countedWeight += r.weight;
  }

  const coverage = { assessed: 0, graded: 0, missing: 0, excused: 0, blank: 0, total: 0, countedWeight, totalWeight };
  const missingAssessments = [];
  for (const a of assessments) {
    if (a.is_parent) continue;
    const sd = lookup[a.assessment_id];
    const state = sd ? sd.state : 'blank';
    coverage.total += 1;
    coverage[state] += 1;
    if (state === 'missing') missingAssessments.push(a);
  }
  coverage.assessed = coverage.graded + coverage.missing;

  return {
    pct: countedWeight > 0 ? (earned / countedWeight) * 100 : null,
    coverage,
    missingAssessments,
  };
}

/** Grades for every student in a class: Map<studentId, computeClassGrade result>. */
function computeClassGradesForAll(assessments, rows) {
  const byStudent = new Map();
  for (const r of rows) {
    if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, []);
    byStudent.get(r.student_id).push(r);
  }
  const out = new Map();
  for (const [studentId, studentRows] of byStudent) {
    out.set(studentId, computeClassGrade(assessments, studentRows));
  }
  return out;
}

/** "2 of 5 assessed · 1 missing · 1 excused" */
function formatCoverage(coverage) {
  if (!coverage) return '';
  const parts = [`${coverage.assessed} of ${coverage.total} assessed`];
  if (coverage.missing) parts.push(`${coverage.missing} missing`);
  if (coverage.excused) parts.push(`${coverage.excused} excused`);
  return parts.join(' · ');
}

/** Report-card mark for a class percentage: 'I' (no evidence), 'R' (below 50), else the number. */
function reportCardMark(pct) {
  if (pct == null || Number.isNaN(pct)) return 'I';
  if (pct < 50) return 'R';
  return pct;
}

module.exports = {
  CELL_STATES,
  STATUSES,
  cellState,
  buildScoreLookup,
  computeAssessmentForStudent,
  computeClassGrade,
  computeClassGradesForAll,
  formatCoverage,
  reportCardMark,
};
