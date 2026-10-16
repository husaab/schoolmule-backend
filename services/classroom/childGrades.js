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
const classworkQueries = require('../../queries/classwork.queries');
const termQueries = require('../../queries/term.queries');
const { resolveTerm } = require('./resolveTerm');
const { identityOf } = require('./classView');
const { missingCountsByClass } = require('./studentWork');

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
      itemId: null, // set by withClasswork from the column's classwork item
      classId: row.class_id,
      subject: row.subject,
      teacherName: row.teacher_name ?? null,
      title: a.name,
      kind: 'assessment', // withClasswork: the item's real kind
      categoryName: a.parentAssessmentId ? names.get(a.parentAssessmentId) ?? null : null,
      score: a.status === 'graded' ? a.score : null,
      maxScore: a.maxScore,
      status: a.status,
      publishedAt: iso(a.publishedAt),
      feedback: null, // withClasswork: the submission's feedback once visible
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
    missingCount: 0, // set in buildChildGrades from the work-status rule (derived + confirmed)
    latestPublishedAt: items.reduce((latest, i) => (i.publishedAt && (!latest || i.publishedAt > latest) ? i.publishedAt : latest), null),
    items,
  };
}

/**
 * Each grade's classwork item: `kind` is the item's kind (an assignment or
 * quiz graded in this column reads as one), and `itemId` is set only when the
 * child may open that item (ITEM_VISIBLE), so a link never leads to a 404.
 * `feedback` is the submission's once visible (spec 0.8), and a grade
 * published to this child on its own (a per-student Publish, spec D3) is
 * dated by that publish, as the child's work page dates it.
 */
async function withClasswork(classes, studentId) {
  const ids = [...new Set(classes.flatMap((c) => c.items.map((i) => i.assessmentId)))];
  if (ids.length === 0) return classes;
  const { rows } = await db.query(classworkQueries.selectItemsForAssessments, [ids, studentId]);
  const byAssessment = new Map(rows.map((r) => [r.assessment_id, r]));
  return classes.map((c) => {
    const items = c.items.map((i) => {
      const item = byAssessment.get(i.assessmentId);
      if (!item) return i;
      return {
        ...i,
        kind: item.kind,
        itemId: item.visible ? item.item_id : null,
        feedback: item.feedback ?? null,
        publishedAt: item.sub_published_at ? iso(item.sub_published_at) : i.publishedAt,
      };
    });
    const latestPublishedAt = items.reduce((latest, i) => (i.publishedAt && (!latest || i.publishedAt > latest) ? i.publishedAt : latest), null);
    return { ...c, items: items.sort(newestFirst), latestPublishedAt };
  });
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
  // The Classroom average rule: shown by the class and at least 5 counted scores.
  const breakdown = engine.getStudentClassBreakdown(matrix, studentId, { classroom: true });
  const byClass = new Map((breakdown?.classes ?? []).map((c) => [c.classId, c]));
  const classes = classRows.map((row) => toChildClassGrades(row, byClass.get(row.class_id)));
  // missingCount follows the one work-status rule (studentWork.js): work past
  // due with nothing turned in, plus a published missing, so Grades agrees
  // with the To-do and the class card.
  const [withItems, missing] = await Promise.all([
    withClasswork(classes, studentId),
    missingCountsByClass({ studentId, school, classIds: classes.map((c) => c.classId) }),
  ]);
  return { ...base, classes: withItems.map((c) => ({ ...c, missingCount: missing.get(c.classId) ?? 0 })) };
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
