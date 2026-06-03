// controllers/analytics.controller.js
//
// Teacher analytics endpoints. School ALWAYS comes from req.user.school
// (the JWT) — never from a query param — so analytics can never leak
// across schools. Every endpoint accepts ?engine=null_skip|null_zero
// (default null_skip; see services/analyticsEngine.js for the difference).

const db = require('../config/database');
const q = require('../queries/analytics.queries');
const logger = require('../logger');
const engine = require('../services/analyticsEngine');
const stats = require('../utils/statsUtils');

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Natural ordering for grade levels ('1'..'8'; JK/SK never appear here). */
function gradeSortKey(g) {
  const n = parseInt(g, 10);
  return Number.isNaN(n) ? 999 : n;
}

/**
 * Per-student overall averages grouped by grade level.
 * Returns Map<gradeLevel, Array<{ studentId, studentName, overallAvg }>>
 * (students with no graded work anywhere are listed with overallAvg=null
 * but excluded from the numeric aggregates).
 */
function groupStudentsByGrade(matrix) {
  const byGrade = new Map();
  for (const cross of matrix.students.values()) {
    const overallAvg = engine.overallAvgForStudent(cross);
    if (!byGrade.has(cross.gradeLevel)) byGrade.set(cross.gradeLevel, []);
    byGrade.get(cross.gradeLevel).push({
      studentId: cross.studentId,
      studentName: cross.studentName,
      overallAvg: stats.round1(overallAvg),
      missingCount: cross.classes.reduce((s, c) => s + c.missingCount, 0),
      classCount: cross.classes.length,
    });
  }
  return byGrade;
}

/** Per-class average: mean of student finalPcts (null-skip aware). */
function classAvgPct(cls) {
  const pcts = [...cls.students.values()].map((s) => s.finalPct).filter((p) => p != null);
  return pcts.length ? stats.round1(stats.mean(pcts)) : null;
}

/** Per-class median of student finalPcts (null-skip aware). */
function classMedianPct(cls) {
  const pcts = [...cls.students.values()].map((s) => s.finalPct).filter((p) => p != null);
  return pcts.length ? stats.round1(stats.median(pcts)) : null;
}

/** Shape the byGrade section of the overview response. */
function buildByGrade(matrix) {
  const byGrade = groupStudentsByGrade(matrix);
  const out = [];
  for (const [grade, students] of byGrade.entries()) {
    const pcts = students.map((s) => s.overallAvg).filter((p) => p != null);
    out.push({
      grade,
      studentCount: students.length,
      stats: stats.summarize(pcts),
      histogram: stats.histogram(pcts),
      students: students.sort((a, b) => (b.overallAvg ?? -1) - (a.overallAvg ?? -1)),
    });
  }
  return out.sort((a, b) => gradeSortKey(a.grade) - gradeSortKey(b.grade));
}

/** Shape the bySubject section of the overview response. */
function buildBySubject(matrix) {
  const bySubject = new Map(); // subject -> { classes: [], studentPcts: [] }
  for (const cls of matrix.classes.values()) {
    const subject = cls.subject || 'Unspecified';
    if (!bySubject.has(subject)) bySubject.set(subject, { classes: [], studentPcts: [] });
    const entry = bySubject.get(subject);
    const avg = classAvgPct(cls);
    entry.classes.push({
      classId: cls.classId,
      grade: cls.grade,
      teacherName: cls.teacherName,
      studentCount: cls.students.size,
      classAvg: avg,
      classMedian: classMedianPct(cls),
    });
    for (const stu of cls.students.values()) {
      if (stu.finalPct != null) entry.studentPcts.push(stu.finalPct);
    }
  }

  const out = [];
  for (const [subject, entry] of bySubject.entries()) {
    out.push({
      subject,
      classCount: entry.classes.length,
      stats: stats.summarize(entry.studentPcts),
      histogram: stats.histogram(entry.studentPcts),
      classes: entry.classes.sort(
        (a, b) => gradeSortKey(a.grade) - gradeSortKey(b.grade) || (b.classAvg ?? -1) - (a.classAvg ?? -1),
      ),
    });
  }
  return out.sort((a, b) => a.subject.localeCompare(b.subject));
}

/** Grade/subject avg diffs between two matrices (current vs compare). */
function buildTermDiff(currentMatrix, compareMatrix) {
  const avgByGrade = (matrix) => {
    const map = new Map();
    for (const [grade, students] of groupStudentsByGrade(matrix).entries()) {
      const pcts = students.map((s) => s.overallAvg).filter((p) => p != null);
      map.set(grade, pcts.length ? stats.mean(pcts) : null);
    }
    return map;
  };
  const avgBySubject = (matrix) => {
    const map = new Map(); // subject -> pcts[]
    for (const cls of matrix.classes.values()) {
      const subject = cls.subject || 'Unspecified';
      if (!map.has(subject)) map.set(subject, []);
      for (const stu of cls.students.values()) {
        if (stu.finalPct != null) map.get(subject).push(stu.finalPct);
      }
    }
    const out = new Map();
    for (const [subject, pcts] of map.entries()) {
      out.set(subject, pcts.length ? stats.mean(pcts) : null);
    }
    return out;
  };

  const curGrades = avgByGrade(currentMatrix);
  const prevGrades = avgByGrade(compareMatrix);
  const byGrade = [];
  for (const [grade, cur] of curGrades.entries()) {
    const prev = prevGrades.get(grade) ?? null;
    byGrade.push({
      grade,
      currentAvg: stats.round1(cur),
      previousAvg: stats.round1(prev),
      avgDiff: cur != null && prev != null ? stats.round1(cur - prev) : null,
    });
  }
  byGrade.sort((a, b) => gradeSortKey(a.grade) - gradeSortKey(b.grade));

  const curSubjects = avgBySubject(currentMatrix);
  const prevSubjects = avgBySubject(compareMatrix);
  const bySubject = [];
  for (const [subject, cur] of curSubjects.entries()) {
    const prev = prevSubjects.get(subject) ?? null;
    bySubject.push({
      subject,
      currentAvg: stats.round1(cur),
      previousAvg: stats.round1(prev),
      avgDiff: cur != null && prev != null ? stats.round1(cur - prev) : null,
    });
  }
  bySubject.sort((a, b) => a.subject.localeCompare(b.subject));

  return { byGrade, bySubject };
}

/** Per-assessment stats for a class (avg/median/completion/anomaly). */
function buildAssessmentStats(cls) {
  const out = [];
  for (const a of cls.assessments) {
    if (a.parent_assessment_id) continue; // top-level only in the stats table

    const pcts = [];
    let gradedCount = 0;
    let eligibleCount = 0;
    for (const stu of cls.students.values()) {
      const row = stu.rows.find((r) => r.assessment_id === a.assessment_id);
      const isExcluded = Boolean(row?.is_excluded);
      if (isExcluded) continue;
      eligibleCount += 1;

      if (a.is_parent) {
        // Parent pct from graded children only (mirrors the null-skip engine).
        const children = cls.assessments.filter((c) => c.parent_assessment_id === a.assessment_id);
        let earned = 0;
        let maxW = 0;
        for (const c of children) {
          const crow = stu.rows.find((r) => r.assessment_id === c.assessment_id);
          if (!crow || crow.is_excluded || crow.score == null) continue;
          const max = parseFloat(c.max_score) || 100;
          const cw = parseFloat(c.weight_points) || 0;
          earned += (max > 0 ? Math.min(parseFloat(crow.score) / max, 1) : 0) * cw;
          maxW += cw;
        }
        if (maxW > 0) {
          pcts.push((earned / maxW) * 100);
          gradedCount += 1;
        }
      } else if (row && row.score != null) {
        const max = parseFloat(a.max_score) || 100;
        pcts.push(max > 0 ? (parseFloat(row.score) / max) * 100 : 0);
        gradedCount += 1;
      }
    }

    const summary = stats.summarize(pcts);
    const completionRate = eligibleCount > 0 ? Math.round((gradedCount / eligibleCount) * 1000) / 1000 : 0;
    out.push({
      assessmentId: a.assessment_id,
      name: a.name,
      date: a.date,
      weightPoints: a.weight_points != null ? parseFloat(a.weight_points) : null,
      isParent: Boolean(a.is_parent),
      completionRate,
      stats: summary,
      histogram: stats.histogram(pcts),
      // Heuristic anomaly flag: very low class average or very high spread.
      isAnomalous: summary != null && (summary.avg < 50 || summary.stdDev > 25),
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// GET /api/analytics/overview?termId=&engine=&compareTerm=
// ────────────────────────────────────────────────────────────────────
const getOverview = async (req, res) => {
  const { school } = req.user;
  const { termId } = req.query;
  if (!termId) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: termId' });
  }
  // Comparison is per-term only: meaningless when viewing all terms combined.
  const compareTerm =
    termId === engine.ALL_TERMS || req.query.compareTerm === engine.ALL_TERMS
      ? null
      : req.query.compareTerm;

  try {
    const eng = engine.normalizeEngine(req.query.engine);
    const [matrix, compareMatrix, termsRes] = await Promise.all([
      engine.buildAnalyticsMatrix(school, termId, eng),
      compareTerm ? engine.buildAnalyticsMatrix(school, compareTerm, eng) : Promise.resolve(null),
      db.query(q.selectTermsBySchool, [school]),
    ]);

    const byGrade = buildByGrade(matrix);
    const allPcts = byGrade.flatMap((g) => g.students.map((s) => s.overallAvg).filter((p) => p != null));

    const data = {
      termId,
      engine: eng,
      terms: termsRes.rows,
      school: {
        stats: stats.summarize(allPcts),
        histogram: stats.histogram(allPcts),
        totalStudents: matrix.students.size,
        totalClasses: matrix.classes.size,
      },
      byGrade,
      bySubject: buildBySubject(matrix),
    };
    if (compareMatrix) {
      data.compareTermId = compareTerm;
      data.termDiff = buildTermDiff(matrix, compareMatrix);
    }

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ status: 'failed', message: error.message });
    }
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching analytics overview' });
  }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/analytics/class/:classId?termId=&engine=
// ────────────────────────────────────────────────────────────────────
const getClassDetail = async (req, res) => {
  const { school } = req.user;
  const { classId } = req.params;

  try {
    const eng = engine.normalizeEngine(req.query.engine);

    let termId = req.query.termId;
    if (!termId) {
      const { rows } = await db.query(q.selectTermIdForClass, [classId, school]);
      if (rows.length === 0) {
        return res.status(404).json({ status: 'failed', message: 'Class not found' });
      }
      termId = rows[0].term_id;
    }

    const matrix = await engine.buildAnalyticsMatrix(school, termId, eng);
    const cls = matrix.classes.get(classId);
    if (!cls) {
      return res.status(404).json({ status: 'failed', message: 'Class not found for this term' });
    }

    // Student rows: finalPct + rank + percentile + raw per-assessment scores.
    const studentList = [...cls.students.values()];
    const classPcts = studentList.map((s) => s.finalPct).filter((p) => p != null);
    const ranked = studentList
      .slice()
      .sort((a, b) => (b.finalPct ?? -1) - (a.finalPct ?? -1));

    const students = ranked.map((stu, idx) => ({
      studentId: stu.studentId,
      studentName: stu.studentName,
      finalPct: stats.round1(stu.finalPct),
      rank: stu.finalPct != null ? idx + 1 : null,
      percentileInClass: stats.round1(stats.percentileRank(stu.finalPct, classPcts)),
      missingCount: stu.missingCount,
      excludedCount: stu.excludedCount,
      assessmentScores: stu.rows.map((r) => ({
        assessmentId: r.assessment_id,
        name: r.assessment_name,
        score: r.score == null ? null : parseFloat(r.score),
        maxScore: r.max_score == null ? null : parseFloat(r.max_score),
        isExcluded: Boolean(r.is_excluded),
        isParent: Boolean(r.is_parent),
        parentAssessmentId: r.parent_assessment_id,
      })),
    }));

    const assessments = buildAssessmentStats(cls);
    const trend = assessments
      .filter((a) => a.date != null && a.stats != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map((a) => ({ assessmentId: a.assessmentId, name: a.name, date: a.date, classAvgPct: a.stats.avg }));

    return res.status(200).json({
      status: 'success',
      data: {
        classId: cls.classId,
        subject: cls.subject,
        grade: cls.grade,
        teacherName: cls.teacherName,
        termId,
        engine: eng,
        summary: { stats: stats.summarize(classPcts), histogram: stats.histogram(classPcts) },
        students,
        assessments,
        trend,
      },
    });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ status: 'failed', message: error.message });
    }
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching class analytics' });
  }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/analytics/student/:studentId?termId=&engine=&compareTerm=
// ────────────────────────────────────────────────────────────────────
const getStudentDetail = async (req, res) => {
  const { school } = req.user;
  const { studentId } = req.params;
  const { termId } = req.query;
  if (!termId) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: termId' });
  }
  const compareTerm =
    termId === engine.ALL_TERMS || req.query.compareTerm === engine.ALL_TERMS
      ? null
      : req.query.compareTerm;

  try {
    const eng = engine.normalizeEngine(req.query.engine);
    const [matrix, attendance, compareMatrix] = await Promise.all([
      engine.buildAnalyticsMatrix(school, termId, eng),
      engine.getAttendanceMap(school, termId),
      compareTerm ? engine.buildAnalyticsMatrix(school, compareTerm, eng) : Promise.resolve(null),
    ]);

    const cross = matrix.students.get(studentId);
    if (!cross) {
      return res.status(404).json({ status: 'failed', message: 'Student not found for this term' });
    }

    const overallAvg = engine.overallAvgForStudent(cross);

    // Percentile within the student's grade cohort (overall averages).
    const cohortPcts = [];
    for (const other of matrix.students.values()) {
      if (other.gradeLevel !== cross.gradeLevel) continue;
      const avg = engine.overallAvgForStudent(other);
      if (avg != null) cohortPcts.push(avg);
    }

    // Per-class breakdown with percentile within each class + missing work.
    const classes = [];
    const missingWork = [];
    for (const enrolled of cross.classes) {
      const cls = matrix.classes.get(enrolled.classId);
      const stu = cls.students.get(studentId);
      const classPcts = [...cls.students.values()].map((s) => s.finalPct).filter((p) => p != null);

      classes.push({
        classId: cls.classId,
        subject: cls.subject,
        teacherName: cls.teacherName,
        finalPct: stats.round1(stu.finalPct),
        classAvg: classAvgPct(cls),
        percentileInClass: stats.round1(stats.percentileRank(stu.finalPct, classPcts)),
        missingCount: stu.missingCount,
        excludedCount: stu.excludedCount,
        assessmentScores: stu.rows.map((r) => ({
          assessmentId: r.assessment_id,
          name: r.assessment_name,
          date: r.assessment_date,
          score: r.score == null ? null : parseFloat(r.score),
          maxScore: r.max_score == null ? null : parseFloat(r.max_score),
          weightPoints: r.weight_points == null ? null : parseFloat(r.weight_points),
          isExcluded: Boolean(r.is_excluded),
          isParent: Boolean(r.is_parent),
          parentAssessmentId: r.parent_assessment_id,
        })),
      });

      for (const a of stu.missingAssessments) {
        missingWork.push({
          classId: cls.classId,
          subject: cls.subject,
          assessmentId: a.assessment_id,
          assessmentName: a.name,
          assessmentDate: a.date,
          weightPoints: a.weight_points == null ? null : parseFloat(a.weight_points),
        });
      }
    }

    const att = attendance.get(studentId) || null;

    const data = {
      studentId: cross.studentId,
      studentName: cross.studentName,
      gradeLevel: cross.gradeLevel,
      termId,
      engine: eng,
      attendance: att ? { presentDays: att.presentDays, totalDays: att.totalDays, pct: att.pct } : null,
      overall: {
        avg: stats.round1(overallAvg),
        classCount: cross.classes.length,
        percentileInGrade: stats.round1(stats.percentileRank(overallAvg, cohortPcts)),
        missingCount: missingWork.length,
      },
      classes,
      missingWork,
    };

    if (compareMatrix) {
      const prevCross = compareMatrix.students.get(studentId);
      const prevAvg = prevCross ? engine.overallAvgForStudent(prevCross) : null;
      data.termTrajectory = {
        currentTermId: termId,
        currentAvg: stats.round1(overallAvg),
        compareTermId: compareTerm,
        compareAvg: stats.round1(prevAvg),
        diff: overallAvg != null && prevAvg != null ? stats.round1(overallAvg - prevAvg) : null,
      };
    }

    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ status: 'failed', message: error.message });
    }
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching student analytics' });
  }
};

// ────────────────────────────────────────────────────────────────────
// GET /api/analytics/snapshot?termId=&engine=
// Compact per-student records for the AI features / at-risk watchlist.
// ────────────────────────────────────────────────────────────────────
const getAiSnapshot = async (req, res) => {
  const { school } = req.user;
  const { termId } = req.query;
  if (!termId) {
    return res.status(400).json({ status: 'failed', message: 'Missing required query parameter: termId' });
  }

  try {
    const snapshot = await engine.buildAiSnapshot(school, termId, req.query.engine);
    return res.status(200).json({ status: 'success', data: snapshot });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ status: 'failed', message: error.message });
    }
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Error fetching analytics snapshot' });
  }
};

// ────────────────────────────────────────────────────────────────────
// POST /api/analytics/invalidate-cache
// Body (all optional): { termId, engine } — always scoped to the JWT school.
// ────────────────────────────────────────────────────────────────────
const invalidateCache = async (req, res) => {
  const { school } = req.user;
  const { termId, engine: eng } = req.body || {};
  try {
    engine.invalidateCache(school, termId, eng);
    return res.status(200).json({ status: 'success', message: 'Analytics cache invalidated' });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ status: 'failed', message: 'Error invalidating analytics cache' });
  }
};

module.exports = {
  getOverview,
  getClassDetail,
  getStudentDetail,
  getAiSnapshot,
  invalidateCache,
};
