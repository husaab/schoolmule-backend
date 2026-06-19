// services/studentViewEvaluator.js
//
// Evaluates a Student View's criteria JSON against current data and
// returns the list of matching students with their computed metric.
//
// Design:
//   - Pure orchestration. SQL lives in queries/studentView.queries.js.
//     Per-class weighted grades come from utils/gradeCalculator.js so
//     this code never disagrees with the gradebook.
//   - One term at a time, then combine per-term results per termScope.
//   - JK/SK students are excluded at the SQL layer (classes filter).
//
// The shape that matters:
//
//   evaluateView(viewRow) →
//     [
//       {
//         studentId, studentName, grade, homeroomTeacherId,
//         perTerm: { [termId]: { qualified, metric } },
//         qualified: true,         // after combining per termScope
//         displayMetric: number    // headline number shown in the UI
//       },
//       ...
//     ]
//

const db = require('../config/database');
const q = require('../queries/studentView.queries');

// ────────────────────────────────────────────────────────────────────
// View-specific grade calc
// ────────────────────────────────────────────────────────────────────
//
// Differs from utils/gradeCalculator on one specific point: null/unentered
// scores are SKIPPED entirely (no weight, no contribution), not treated as 0.
// Rationale: awards/recognition should reflect a student's performance on
// completed work. If a student is enrolled in a class with no entered scores,
// they don't appear in the class's average at all.
//
// Returns the student's % in the class, or `null` if they have zero graded
// assessments in this class (in which case the class is excluded from their
// across-class average).
function computeClassPctForStudent(assessments, scoreRowsForStudent) {
  const scoreLookup = {};
  for (const row of scoreRowsForStudent) {
    scoreLookup[row.assessment_id] = {
      score: row.score == null ? null : parseFloat(row.score),
      isExcluded: Boolean(row.is_excluded),
    };
  }

  const topLevel = assessments.filter((a) => !a.parent_assessment_id);

  let earned = 0;       // sum of (pct × weight) for graded assessments
  let activeWeight = 0; // sum of weights of graded assessments

  for (const a of topLevel) {
    const sd = scoreLookup[a.assessment_id];
    if (sd?.isExcluded) continue;

    const weight = parseFloat(a.weight_points) || 0;

    if (a.is_parent) {
      const children = assessments.filter((c) => c.parent_assessment_id === a.assessment_id);
      let childEarned = 0;
      let childMax = 0;
      for (const c of children) {
        const csd = scoreLookup[c.assessment_id];
        if (csd?.isExcluded) continue;
        if (csd?.score == null) continue; // skip ungraded children
        const max = parseFloat(c.max_score) || 100;
        const cw = parseFloat(c.weight_points) || 0;
        const pct = max > 0 ? Math.min(csd.score / max, 1) : 0;
        childEarned += pct * cw;
        childMax += cw;
      }
      if (childMax === 0) continue; // no graded children → skip parent
      const parentPct = (childEarned / childMax) * 100;
      earned += (parentPct * weight) / 100;
      activeWeight += weight;
    } else {
      if (sd?.score == null) continue; // skip ungraded standalone
      const max = parseFloat(a.max_score) || 100;
      const pct = max > 0 ? (sd.score / max) * 100 : 0;
      earned += (pct * weight) / 100;
      activeWeight += weight;
    }
  }

  if (activeWeight === 0) return null;
  return (earned / activeWeight) * 100;
}

// ────────────────────────────────────────────────────────────────────
// USER CONTRIBUTION GOES HERE
// ────────────────────────────────────────────────────────────────────
//
// Given a single student's percentages across their classes for ONE term,
// decide whether they qualify under the given aggregation mode, and what
// metric to surface to the UI.
//
// Inputs:
//   classPercentages — number[] of the student's per-class % for this term,
//                      already computed by calculateBulkGrades.
//                      Empty array means the student has zero applicable
//                      classes in this term.
//   threshold        — number, e.g., 85
//   mode             — 'overall_avg' | 'every_class' | 'any_class'
//
// Output: { qualified: boolean, metric: number }
//   - For 'overall_avg':  metric = the student's overall average; qualified = avg ≥ threshold
//   - For 'every_class':  metric = the student's LOWEST class %;   qualified = min ≥ threshold
//   - For 'any_class':    metric = the student's HIGHEST class %;  qualified = max ≥ threshold
//   - If classPercentages is empty: return { qualified: false, metric: 0 } — a student
//     with no classes in a term can never qualify for that term.
//
// Trade-off to think about:
//   For 'overall_avg', the simplest implementation is a flat arithmetic mean.
//   An alternative is to weight each class by its total assessment points so
//   a 5-credit course counts more than a 1-credit elective. Pick one, comment
//   the choice, and we can revisit later if real-world data needs the other.
//
function applyAggregation(classPercentages, threshold, mode) {
  if (!classPercentages || classPercentages.length === 0) {
    return { qualified: false, metric: 0 };
  }

  // Flat arithmetic mean for overall_avg. Easy to revisit if real-world data
  // shows a need for point-weighted averaging.
  let metric;
  switch (mode) {
    case 'overall_avg':
      metric = classPercentages.reduce((s, p) => s + p, 0) / classPercentages.length;
      break;
    case 'every_class':
      metric = Math.min(...classPercentages);
      break;
    case 'any_class':
      metric = Math.max(...classPercentages);
      break;
    default:
      return { qualified: false, metric: 0 };
  }
  return { qualified: metric >= threshold, metric };
}

// ────────────────────────────────────────────────────────────────────
// Term scope resolution
// ────────────────────────────────────────────────────────────────────

async function resolveTermIds(school, criteria) {
  const { rows: terms } = await db.query(q.selectTermsBySchool, [school]);

  switch (criteria.termScope) {
    case 'active': {
      const active = terms.find((t) => t.is_active);
      return active ? [active.term_id] : [];
    }
    case 'all':
      return terms.map((t) => t.term_id);
    case 'specific':
    case 'every_listed':
    case 'any_listed':
      // Seeded "Both Terms" view uses a marker so it stays school-agnostic.
      if (criteria.termIdsMode === 'FIRST_TWO_TERMS') {
        return terms.slice(0, 2).map((t) => t.term_id);
      }
      return Array.isArray(criteria.termIds) ? criteria.termIds : [];
    default:
      return [];
  }
}

// ────────────────────────────────────────────────────────────────────
// Per-term evaluation
// ────────────────────────────────────────────────────────────────────

async function evaluateTerm(school, termId, criteria) {
  const gradeLevels = criteria.gradeLevels || [];
  const subjects = criteria.subjects || [];

  const { rows: classes } = await db.query(q.selectClassesForEvaluation, [
    school,
    termId,
    gradeLevels,
    subjects,
  ]);

  // For each class, compute every enrolled student's %.
  const perStudentClassPcts = new Map(); // studentId → { studentName, grade, homeroomTeacherId, pcts: number[] }

  for (const cls of classes) {
    const { rows: scoreRows } = await db.query(q.selectScoresForClass, [cls.class_id]);
    if (scoreRows.length === 0) continue;

    // Build assessment list (de-duped) from the joined rows.
    const seen = new Set();
    const assessments = [];
    for (const r of scoreRows) {
      if (seen.has(r.assessment_id)) continue;
      seen.add(r.assessment_id);
      assessments.push({
        assessment_id: r.assessment_id,
        name: r.assessment_name,
        weight_percent: r.weight_percent,
        weight_points: r.weight_points,
        max_score: r.max_score,
        is_parent: r.is_parent,
        parent_assessment_id: r.parent_assessment_id,
      });
    }

    // Group score rows by student for this class.
    const rowsByStudent = new Map();
    for (const r of scoreRows) {
      if (!rowsByStudent.has(r.student_id)) rowsByStudent.set(r.student_id, []);
      rowsByStudent.get(r.student_id).push(r);
    }

    for (const [studentId, studentRows] of rowsByStudent.entries()) {
      const pct = computeClassPctForStudent(assessments, studentRows);
      if (!perStudentClassPcts.has(studentId)) {
        const first = studentRows[0];
        perStudentClassPcts.set(studentId, {
          studentName: first.student_name,
          grade: first.student_grade,
          homeroomTeacherId: first.homeroom_teacher_id,
          pcts: [],
        });
      }
      // Only count the class for the student if they had graded work in it.
      if (pct != null) {
        perStudentClassPcts.get(studentId).pcts.push(pct);
      }
    }
  }

  // Apply aggregation mode (user-written function) to each student.
  const result = new Map(); // studentId → { qualified, metric, studentName, grade, homeroomTeacherId }
  for (const [studentId, info] of perStudentClassPcts.entries()) {
    const { qualified, metric } = applyAggregation(
      info.pcts,
      criteria.thresholdPercent,
      criteria.aggregationMode,
    );
    result.set(studentId, {
      qualified,
      metric,
      studentName: info.studentName,
      grade: info.grade,
      homeroomTeacherId: info.homeroomTeacherId,
    });
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Combine per-term sets per termScope
// ────────────────────────────────────────────────────────────────────

function combinePerTerm(termResults, termIds, termScope, criteria = {}) {
  // termResults: Map<termId, Map<studentId, perTermEntry>>
  const allStudentIds = new Set();
  for (const map of termResults.values()) {
    for (const sid of map.keys()) allStudentIds.add(sid);
  }

  // Multi-term scopes can use cumulative_avg: instead of per-term qualification,
  // we average the student's metric across terms and check that single number.
  const isMultiTerm = ['every_listed', 'any_listed', 'all'].includes(termScope);
  const crossTermMode = criteria.crossTermAggregation || 'each_term_separately';
  const useCumulative = isMultiTerm && crossTermMode === 'cumulative_avg';
  const threshold = typeof criteria.thresholdPercent === 'number' ? criteria.thresholdPercent : 0;

  const out = [];
  for (const sid of allStudentIds) {
    const perTerm = {};
    let qualifiedTerms = 0;
    let metricSum = 0;
    let metricCount = 0;
    let baseInfo = null;

    for (const termId of termIds) {
      const entry = termResults.get(termId)?.get(sid);
      if (entry) {
        baseInfo = baseInfo || entry;
        perTerm[termId] = { qualified: entry.qualified, metric: entry.metric };
        if (entry.qualified) qualifiedTerms += 1;
        // Only include the term in the display average if the student
        // actually had graded work that term (metric > 0). Otherwise it
        // would tank an otherwise valid headline number.
        if (entry.metric > 0) {
          metricSum += entry.metric;
          metricCount += 1;
        }
      } else {
        perTerm[termId] = { qualified: false, metric: 0 };
      }
    }
    if (!baseInfo) continue;

    const cumulativeMean = metricCount > 0 ? metricSum / metricCount : 0;

    let qualified;
    if (useCumulative) {
      // Single threshold check against the cross-term mean. The student must
      // have had graded work in at least one term — students with zero data
      // never qualify cumulatively either.
      qualified = metricCount > 0 && cumulativeMean >= threshold;
    } else {
      switch (termScope) {
        case 'active':
        case 'specific':
          qualified = perTerm[termIds[0]]?.qualified === true;
          break;
        case 'every_listed':
        case 'all':
          qualified = qualifiedTerms === termIds.length;
          break;
        case 'any_listed':
          qualified = qualifiedTerms > 0;
          break;
        default:
          qualified = false;
      }
    }

    out.push({
      studentId: sid,
      studentName: baseInfo.studentName,
      grade: baseInfo.grade,
      homeroomTeacherId: baseInfo.homeroomTeacherId,
      perTerm,
      qualified,
      displayMetric: metricCount > 0 ? metricSum / metricCount : 0,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Attendance gate (applied last, optional)
// ────────────────────────────────────────────────────────────────────

async function applyAttendanceFilter(students, school, termIds, criteria) {
  if (criteria.attendanceMinPercent == null) return students;

  // Use the first term in scope as the attendance window; multi-term attendance
  // is computed as the simple mean of per-term %s so the rule is consistent
  // with how termScope=every_listed treats grades.
  const perStudentAttendance = new Map(); // studentId → avg %
  for (const termId of termIds) {
    const { rows } = await db.query(q.selectAttendancePctForTerm, [termId, school]);
    for (const r of rows) {
      const prev = perStudentAttendance.get(r.student_id) || { sum: 0, n: 0 };
      prev.sum += Number(r.attendance_pct);
      prev.n += 1;
      perStudentAttendance.set(r.student_id, prev);
    }
  }

  return students.filter((s) => {
    if (!s.qualified) return false;
    const att = perStudentAttendance.get(s.studentId);
    const pct = att && att.n > 0 ? att.sum / att.n : 0;
    return pct >= criteria.attendanceMinPercent;
  });
}

// ────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────

async function evaluateView(viewRow) {
  const { school, criteria } = viewRow;
  const termIds = await resolveTermIds(school, criteria);
  if (termIds.length === 0) return [];

  const termResults = new Map();
  for (const termId of termIds) {
    termResults.set(termId, await evaluateTerm(school, termId, criteria));
  }

  let combined = combinePerTerm(termResults, termIds, criteria.termScope, criteria);
  combined = await applyAttendanceFilter(combined, school, termIds, criteria);
  return combined.filter((s) => s.qualified);
}

module.exports = {
  evaluateView,
  // exported for unit testing
  applyAggregation,
  combinePerTerm,
  resolveTermIds,
  // null-skip per-class grade: used by Student Views and the analytics
  // null_skip engine. (The Al Haadi T2 report card uses the gradebook
  // missing-zero engine instead, so it agrees with the gradebook.)
  computeClassPctForStudent,
};
