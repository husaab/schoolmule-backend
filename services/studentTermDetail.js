// services/studentTermDetail.js
//
// One student's term in full: overall average, percentile within their grade
// cohort, every class with its percentile and assessment scores, flagged
// missing work, attendance and (optionally) the change against a second term.
//
// Shared by GET /api/analytics/student/:id and the staff student profile
// (GET /api/students/:id/grades) so the two pages can never disagree. Every
// number comes from the cached analytics matrix, i.e. the one grade engine.

const engine = require('./analyticsEngine');
const { cellState } = require('./gradeEngine');
const stats = require('../utils/statsUtils');

/** Mean of a class's non-null finalPcts (null-skip aware). */
function classAvgPct(cls) {
  const pcts = [...cls.students.values()].map((s) => s.finalPct).filter((p) => p != null);
  return pcts.length ? stats.round1(stats.mean(pcts)) : null;
}

/**
 * Returns the detail payload, or null when the student has no classes in
 * the term (archived and JK/SK students never appear in the matrix).
 */
async function buildStudentTermDetail(school, studentId, termId, { compareTerm = null } = {}) {
  const eng = engine.ENGINE_NAME;
  const [matrix, attendance, compareMatrix] = await Promise.all([
    engine.buildAnalyticsMatrix(school, termId, eng),
    engine.getAttendanceMap(school, termId),
    compareTerm ? engine.buildAnalyticsMatrix(school, compareTerm, eng) : Promise.resolve(null),
  ]);

  const cross = matrix.students.get(studentId);
  if (!cross) return null;

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
      coverage: stu.coverage,
      missingCount: stu.missingCount,
      excludedCount: stu.excludedCount,
      notYetGradedCount: stu.notYetGradedCount,
      assessmentScores: stu.rows.map((r) => ({
        assessmentId: r.assessment_id,
        name: r.assessment_name,
        date: r.assessment_date,
        score: r.score == null ? null : parseFloat(r.score),
        maxScore: r.max_score == null ? null : parseFloat(r.max_score),
        weightPoints: r.weight_points == null ? null : parseFloat(r.weight_points),
        status: cellState(r),
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
      notYetGradedCount: cross.classes.reduce((sum, c) => sum + (c.notYetGradedCount || 0), 0),
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

  return data;
}

module.exports = { buildStudentTermDetail };
