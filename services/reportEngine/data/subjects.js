// services/reportEngine/data/subjects.js
//
// Report-card subject rows for grades 1-8. Two shapes, as today:
//
//   standard   one mark per subject from every class the student is in
//              (controllers/reportCard.controller.js:34 + :682-708)
//   Al Haadi   First / Second / Final Term rows when school = ALHAADIACADEMY
//   Term 2     and the term contains "term 2" (reportCard.controller.js:760)
//
// Marks come from the one grade engine (services/gradeEngine.js). A mark is
// a number, 'I' (enrolled, no evidence) or null (no mark for that term at
// all — the T2 card's "—").

const { computeClassGrade } = require('../../gradeEngine');
const reportCardQueries = require('../../../queries/reportCard.queries');
const alHaadiT2Queries = require('../../../queries/alHaadiT2ReportCard.queries');
const studentViewQueries = require('../../../queries/studentView.queries');
const q = require('../../../queries/reportEngineData.queries');
const { text } = require('./format');

// ───────────────────────────────────────────────── standard report card ──

/**
 * Final grade per subject from every class the student is enrolled in (any
 * term), averaged across classes that share a subject; all-null → null.
 * Mirrors calculateSubjectGradesForStudent (reportCard.controller.js:34).
 * @returns {Promise<Array<{ subject_name: string, final_grade: number|null }>>}
 */
async function computeSubjectGrades(client, studentId) {
  const { rows: classRows } = await client.query(q.selectStudentClasses, [studentId]);
  if (classRows.length === 0) return [];

  const subjectMap = new Map();
  for (const cls of classRows) {
    const { rows: assessments } = await client.query(q.selectClassAssessments, [cls.class_id]);
    const { rows: scores } = await client.query(q.selectStudentClassScores, [studentId, cls.class_id]);
    const { pct } = computeClassGrade(assessments, scores);
    if (!subjectMap.has(cls.subject)) subjectMap.set(cls.subject, []);
    subjectMap.get(cls.subject).push(pct);
  }

  const results = [];
  for (const [subject, grades] of subjectMap) {
    const graded = grades.filter((g) => g != null);
    results.push({
      subject_name: subject,
      final_grade: graded.length ? graded.reduce((sum, g) => sum + g, 0) / graded.length : null,
    });
  }
  results.sort((a, b) => a.subject_name.localeCompare(b.subject_name));
  return results;
}

/**
 * The report-card feedback rows under `term`, one per class that has one,
 * in enrolment-query order (reportCard.controller.js:688-708). A subject
 * taken in two classes keeps the FIRST row found, as the template's
 * feedbacks.find(...) does.
 */
async function loadReportCardFeedback(client, studentId, term) {
  const { rows: classRows } = await client.query(q.selectStudentClasses, [studentId]);
  const feedbacks = [];
  for (const cls of classRows) {
    const { rows } = await client.query(reportCardQueries.selectFeedback, [studentId, cls.class_id, term]);
    if (rows.length > 0) feedbacks.push({ subject: cls.subject, ...rows[0] });
  }
  return feedbacks;
}

const findFeedback = (feedbacks, subject) => (feedbacks || []).find((fb) => fb.subject === subject);

function termResult(mark, fb) {
  return {
    mark,
    workHabits: text(fb?.work_habits || ''),
    behaviour: text(fb?.behavior || ''),
    comment: text(fb?.comment || ''),
  };
}

/** SubjectRow[] for the standard (single-mark) report card. */
async function buildReportCardSubjects(client, studentId, term) {
  const grades = await computeSubjectGrades(client, studentId);
  const feedbacks = await loadReportCardFeedback(client, studentId, term);
  return grades.map((g) => {
    // The template formats a null grade as 'I' (formatReportMark).
    const mark = g.final_grade == null ? 'I' : Number(g.final_grade);
    const fb = findFeedback(feedbacks, g.subject_name);
    const current = termResult(mark, fb);
    return {
      id: g.subject_name,
      name: g.subject_name,
      teacher: '',
      mark,
      workHabits: current.workHabits,
      behaviour: current.behaviour,
      coreStandards: '',
      comment: current.comment,
      terms: {},
    };
  });
}

// ──────────────────────────────────────────── Al Haadi Term-2 three-row ──

/**
 * The school's Term 1 and Term 2 rows for the year implied by `termString`.
 * Mirrors resolveAlHaadiTermPair (reportCard.controller.js:130).
 */
async function resolveAlHaadiTermPair(client, school, termString) {
  let t2 = null;
  const { rows: exactRows } = await client.query(alHaadiT2Queries.selectTermByNameAndSchool, [termString, school]);
  if (exactRows.length > 0) {
    t2 = exactRows[0];
  } else {
    const { rows: likeRows } = await client.query(alHaadiT2Queries.selectTermLike, [school, '%term 2%']);
    t2 = likeRows[0] || null;
  }

  let t1 = null;
  if (t2) {
    const { rows: t1Rows } = await client.query(alHaadiT2Queries.selectTerm1ForAcademicYear, [school, t2.academic_year]);
    t1 = t1Rows[0] || null;
  }
  if (!t1) {
    const { rows: fallbackRows } = await client.query(alHaadiT2Queries.selectTermLike, [school, '%term 1%']);
    t1 = fallbackRows[0] || null;
  }
  return { t1, t2 };
}

/**
 * subject → pct | null for one term. Enrolled with no evidence = null ('I');
 * a subject absent from the map wasn't taken that term ('—'). Mirrors
 * computeTermSubjectGrades (reportCard.controller.js:178).
 */
async function computeTermSubjectGrades(client, studentId, termId) {
  if (!termId) return new Map();
  const subjectPcts = new Map();
  const { rows: classRows } = await client.query(alHaadiT2Queries.selectStudentClassesForTerm, [studentId, termId]);

  for (const cls of classRows) {
    const { rows: scoreRows } = await client.query(studentViewQueries.selectScoresForClass, [cls.class_id]);
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
    const studentRows = scoreRows.filter((r) => r.student_id === studentId);
    const { pct } = computeClassGrade(assessments, studentRows);
    if (!subjectPcts.has(cls.subject)) subjectPcts.set(cls.subject, []);
    subjectPcts.get(cls.subject).push(pct);
  }

  const result = new Map();
  for (const [subject, pcts] of subjectPcts) {
    const graded = pcts.filter((p) => p != null);
    result.set(subject, graded.length > 0 ? graded.reduce((s, p) => s + p, 0) / graded.length : null);
  }
  return result;
}

/**
 * { subject, t1, t2, final } rows, sorted by subject. A cell is a number,
 * 'I' (ran that term, no evidence) or null (didn't run that term). Final is
 * the average of two numbers, 'I' when both terms ran but one lacks
 * evidence, else null. Copy of mergeTermSubjects
 * (reportCard.controller.js:244) — kept here so this module doesn't load
 * the controller (and Puppeteer) to reuse a pure function.
 */
function mergeTermSubjects(t1Map, t2Map) {
  const subjects = new Set([...t1Map.keys(), ...t2Map.keys()]);
  const cell = (map, subject) => (map.has(subject) ? (map.get(subject) ?? 'I') : null);
  const rows = [];
  for (const subject of subjects) {
    const t1 = cell(t1Map, subject);
    const t2 = cell(t2Map, subject);
    let final = null;
    if (typeof t1 === 'number' && typeof t2 === 'number') final = (t1 + t2) / 2;
    else if (t1 != null && t2 != null) final = 'I';
    rows.push({ subject, t1, t2, final });
  }
  rows.sort((a, b) => a.subject.localeCompare(b.subject));
  return rows;
}

/**
 * Feedback for one term's classes, read under `termName` — the name the
 * rows were saved under (reportCard.controller.js:847).
 */
async function fetchTermFeedback(client, studentId, termRow, termName) {
  const rows = [];
  if (!termRow) return rows;
  const { rows: termClasses } = await client.query(alHaadiT2Queries.selectStudentClassesForTerm, [studentId, termRow.term_id]);
  for (const cls of termClasses) {
    const { rows: fbRows } = await client.query(reportCardQueries.selectFeedback, [studentId, cls.class_id, termName]);
    if (fbRows.length > 0) rows.push({ subject: cls.subject, ...fbRows[0] });
  }
  return rows;
}

/** SubjectRow[] for the Al Haadi Term-2 card: terms.t1 / t2 / final filled. */
async function buildAlHaadiT2Subjects(client, studentId, school, term) {
  const { t1, t2 } = await resolveAlHaadiTermPair(client, school, term);
  const t1Map = await computeTermSubjectGrades(client, studentId, t1?.term_id || null);
  const t2Map = await computeTermSubjectGrades(client, studentId, t2?.term_id || null);
  const merged = mergeTermSubjects(t1Map, t2Map);

  // Each row carries its own term's work habits / behaviour; T1 feedback is
  // read under the T1 term's name, T2 under the generation term string.
  const feedbacksT1 = await fetchTermFeedback(client, studentId, t1, t1?.name);
  const feedbacksT2 = await fetchTermFeedback(client, studentId, t2, term);

  return merged.map((s) => {
    const r1 = termResult(s.t1, findFeedback(feedbacksT1, s.subject));
    const r2 = termResult(s.t2, findFeedback(feedbacksT2, s.subject));
    return {
      id: s.subject,
      name: s.subject,
      teacher: '',
      mark: s.t2,
      workHabits: r2.workHabits,
      behaviour: r2.behaviour,
      coreStandards: '',
      // The card's teacher comment is Term 2's only.
      comment: r2.comment,
      terms: {
        t1: r1,
        t2: r2,
        final: { mark: s.final, workHabits: '', behaviour: '', comment: '' },
      },
    };
  });
}

module.exports = {
  computeSubjectGrades,
  loadReportCardFeedback,
  buildReportCardSubjects,
  resolveAlHaadiTermPair,
  computeTermSubjectGrades,
  mergeTermSubjects,
  fetchTermFeedback,
  buildAlHaadiT2Subjects,
};
