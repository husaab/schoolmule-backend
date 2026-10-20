// services/publishBackfill.js
//
// Catch-up for the child-only publish bug (fixed 2026-10-19, 8459c5b):
// grades published from inside a category went live, but no parent email
// was sent. planCatchUp turns the missed (publish, student) pairs into one
// email per student with a section per class, from the grades as they are
// now: only columns still published, each class listed through its category
// lines exactly as a normal publish email is (publishDigestTasks). Pure; the
// script (scripts/backfillPublishDigests.js) loads the data and sends.

const { publishDigestTasks } = require('../controllers/assessmentPublish.controller');

/**
 * pairs: [{ batchId, classId, studentId, assessmentIds, triggeredBy }]
 * classes: Map classId → { className, allAssessments, scoreRowsByStudent }, in the order sections should appear
 * Returns [{ studentId, studentName, classes: [{ classId, className, lines, runningGradeLabel, audit }] }],
 * where audit lists, per original publish, the columns this email covers (for the email log).
 */
function planCatchUp({ pairs, classes }) {
  const byStudent = new Map();
  for (const p of pairs) {
    if (!byStudent.has(p.studentId)) byStudent.set(p.studentId, new Map());
    const perClass = byStudent.get(p.studentId);
    if (!perClass.has(p.classId)) perClass.set(p.classId, []);
    perClass.get(p.classId).push(p);
  }

  const plans = [];
  for (const [studentId, perClass] of byStudent) {
    let studentName = null;
    const sections = [];
    for (const [classId, cls] of classes) {
      const missed = perClass.get(classId);
      const rows = cls.scoreRowsByStudent.get(studentId);
      if (!missed || !rows) continue;
      const published = new Set(cls.allAssessments.filter((a) => a.is_published).map((a) => a.assessment_id));
      const audit = missed
        .map((p) => ({ batchId: p.batchId, triggeredBy: p.triggeredBy, assessmentIds: p.assessmentIds.filter((id) => published.has(id)) }))
        .filter((a) => a.assessmentIds.length > 0);
      const ids = [...new Set(audit.flatMap((a) => a.assessmentIds))];
      const [task] = publishDigestTasks(ids, cls.allAssessments, new Map([[studentId, rows]]));
      if (!task) continue; // nothing graded that is still published
      studentName = task.studentName;
      sections.push({ classId, className: cls.className, lines: task.lines, runningGradeLabel: task.runningGradeLabel, audit });
    }
    if (sections.length > 0) plans.push({ studentId, studentName, classes: sections });
  }
  return plans.sort((a, b) => String(a.studentName).localeCompare(String(b.studentName)));
}

module.exports = { planCatchUp };
