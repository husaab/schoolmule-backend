// services/classroom/childGrades.js
//
// A child's published grades, as the student reads them in the portal and a
// parent reads them through the lens. There is no grade math here: every
// number comes from the shared engine (services/analyticsEngine.js over
// services/gradeEngine.js) on the same published-only matrix the parent
// portal uses, and getStudentClassBreakdown picks out this one student, so a
// classmate's work never enters the payload (the per-assessment class
// averages are dropped; the class average shows only when the class opts in).

const db = require('../../config/database');
const engine = require('../analyticsEngine');
const q = require('../../queries/childClassroom.queries');
const termQueries = require('../../queries/term.queries');
const { resolveTerm } = require('./resolveTerm');
const { identityOf } = require('./classView');

// The parent portal's PARENT_VIEW: unpublished assessments are pruned before
// the engine runs, so they neither show nor count.
const PUBLISHED_ONLY = Object.freeze({ publishedOnly: true });
const NO_MARKS = new Set(['JK', 'SK']); // kindergarten records skills, not marks
const SHOWN_STATES = new Set(['graded', 'missing', 'excused']); // a blank cell is not a grade yet
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iso = (value) => (value ? new Date(value).toISOString() : null);
const publishedTime = (item) => (item.publishedAt ? Date.parse(item.publishedAt) : -Infinity);
const newestFirst = (a, b) => publishedTime(b) - publishedTime(a) || a.title.localeCompare(b.title);

/** ?termId= is absent, the 'all' sentinel, or a UUID; anything else is a 400 for the caller. */
const isTermParamValid = (value) =>
  value === undefined || value === '' || value === engine.ALL_TERMS || UUID_RE.test(String(value));

/**
 * The GradeItems of one class's breakdown: leaf assessments with a grade
 * (graded, missing or excused), newest first. Missing and excused carry no
 * score. `row` is the class's selectGradeClasses row.
 */
function gradeItemsOf(cls, row) {
  const names = new Map(cls.assessmentScores.map((a) => [a.assessmentId, a.name]));
  return cls.assessmentScores
    .filter((a) => !a.isParent && SHOWN_STATES.has(a.status))
    .map((a) => ({
      assessmentId: a.assessmentId,
      itemId: null, // T14 maps assessments to classwork items
      classId: row.class_id,
      subject: row.subject,
      teacherName: row.teacher_name ?? null,
      title: a.name,
      kind: 'assessment',
      categoryName: a.parentAssessmentId ? names.get(a.parentAssessmentId) ?? null : null,
      score: a.status === 'graded' ? a.score : null,
      maxScore: a.maxScore,
      status: a.status,
      publishedAt: iso(a.publishedAt),
      feedback: null, // T16: submission feedback
      parentComment: a.parentComment ?? null,
    }))
    .sort(newestFirst);
}

/** One class of ChildGrades; `cls` is the class's breakdown, absent when nothing is published there yet. */
function toChildClassGrades(row, cls) {
  const items = cls ? gradeItemsOf(cls, row) : [];
  return {
    classId: row.class_id,
    subject: row.subject,
    teacherName: row.teacher_name ?? null,
    identity: identityOf(row),
    finalPct: cls ? cls.finalPct ?? null : null,
    classAvg: row.show_class_average && cls ? cls.classAvg ?? null : null,
    gradedCount: items.filter((i) => i.status === 'graded').length,
    missingCount: items.filter((i) => i.status === 'missing').length,
    latestPublishedAt: items.reduce((latest, i) => (i.publishedAt && (!latest || i.publishedAt > latest) ? i.publishedAt : latest), null),
    items,
  };
}

/**
 * A child's published grades for the term in `req` (?termId=, else the
 * selected year's default; see resolveTerm).
 * @param {{ studentId: string, school: string, req: object }} p
 * @returns {Promise<object>} ChildGrades
 */
async function buildChildGrades({ studentId, school, req }) {
  const yearId = req.schoolYear?.schoolYearId ?? null;
  const [{ rows: profileRows }, { rows: termRows }, { termId }] = await Promise.all([
    db.query(q.selectChildProfile, [studentId]),
    db.query(termQueries.selectTermsBySchool, [school, yearId]),
    resolveTerm(req),
  ]);
  const student = profileRows[0];
  const base = {
    studentId,
    usesMarks: !NO_MARKS.has(student?.grade),
    termId: termId ?? null,
    terms: termRows.map((t) => ({ termId: t.term_id, name: t.name, isActive: Boolean(t.is_active) })),
    classes: [],
  };
  if (!student || student.school !== school || !base.usesMarks || !termId) return base;

  const [matrix, { rows: classRows }] = await Promise.all([
    engine.buildAnalyticsMatrix(school, termId, engine.normalizeEngine(), PUBLISHED_ONLY),
    db.query(q.selectGradeClasses, [studentId, school, termId === engine.ALL_TERMS ? null : termId]),
  ]);
  const breakdown = engine.getStudentClassBreakdown(matrix, studentId);
  const byClass = new Map((breakdown?.classes ?? []).map((c) => [c.classId, c]));
  return { ...base, classes: classRows.map((row) => toChildClassGrades(row, byClass.get(row.class_id))) };
}

/** Every GradeItem of a ChildGrades, newest first. */
const allItems = (grades) => grades.classes.flatMap((c) => c.items).sort(newestFirst);

/** The GradeItems published within the last `sinceDays`, newest first, at most `limit`. */
function recentItems(grades, { sinceDays = 14, limit = 5, now = Date.now() } = {}) {
  const since = now - sinceDays * DAY_MS;
  return allItems(grades).filter((i) => publishedTime(i) >= since).slice(0, limit);
}

/**
 * The child's new grades: published within `sinceDays`, newest first.
 * @returns {Promise<object[]>} GradeItem[]
 */
async function newGradesFor({ studentId, school, req, sinceDays = 14, limit = 5 }) {
  return recentItems(await buildChildGrades({ studentId, school, req }), { sinceDays, limit });
}

module.exports = { PUBLISHED_ONLY, isTermParamValid, buildChildGrades, newGradesFor, allItems, recentItems };
