// controllers/parentClassroom.controller.js
//
// The parent's Classes page (/api/parent-portal/classroom/... and
// /api/parent-portal/students/:studentId/classroom/...). requireParent runs
// for the whole router and verifyParentOwnsStudent on every per-child route,
// so a parent reads only their own children. The lens reuses the student
// portal's read model (services/classroom/childClassroom.js, childGrades.js)
// with the parent as the reader: it shows a child's classes exactly as the
// child sees them, with the parent's own read and "Got it" state. Classwork
// comes from the student's own service (studentWork.js) read-only: no
// submission row is ever created and every can* flag is false.

const logger = require('../logger');
const {
  loadChild, loadChildClassroom, listChildClasses, getChildClass, getChildStream, listParentChildren, listAckNeeded,
} = require('../services/classroom/childClassroom');
const work = require('../services/classroom/studentWork');
const { newestDueFirst } = require('../services/classroom/todoGroups');
const { buildChildGrades, isTermParamValid, allItems, recentItems } = require('../services/classroom/childGrades');
const { listStudentStream } = require('../services/classroom/studentStream');
const db = require('../config/database');
const emailQueries = require('../queries/classroomEmail.queries');
const { loadPrefs } = require('../services/classroom/classroomNotifier');

const ok = (res, data) => res.status(200).json({ status: 'success', data });
const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });

const NEW_GRADE_DAYS = 7;
const RECENT_POSTS = 2;
// The Stream lists pinned posts first; read a few more than needed and keep
// the newest by date.
const RECENT_POSTS_WINDOW = 10;
const STREAM_LIMIT = 30;
const MAX_STREAM_LIMIT = 100;

const NOT_ENROLLED = { status: 'failed', code: 'NOT_ENROLLED', message: "This student isn't in this class" };

const byNewest = (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt);

/** A service error (httpError) answers as itself; anything else is logged as a 500. */
function fail(res, error, userMessage, context) {
  if (error && error.expose && error.status) {
    return res.status(error.status).json({ status: 'failed', message: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  logger.error({ err: error, ...context }, userMessage);
  return failed(res, 500, userMessage);
}

// GET /api/parent-portal/classroom/summary
// "Needs you" (posts asking for a "Got it", then each child's missing work due
// in the last 14 days) plus one card per child of the selected year. Grades
// use the default term of the year (the summary takes no ?termId=); due this
// week (assigned, due within 7 days) and missing come from the child's
// current-term work, the same rows the child's To-do shows.
const getClassroomSummary = async (req, res) => {
  const { userId, school } = req.user;
  const schoolYearId = req.schoolYear?.schoolYearId ?? null;
  const gradesReq = { query: {}, user: req.user, schoolYear: req.schoolYear };
  try {
    const [children, needsYou] = await Promise.all([
      listParentChildren({ parentId: userId, school, schoolYearId }),
      listAckNeeded({ parentId: userId, school, schoolYearId }),
    ]);

    const now = new Date();
    const missingRows = [];
    const summaries = await Promise.all(children.map(async (c) => {
      const studentId = c.student_id;
      const childYearId = c.school_year_id ?? schoolYearId;
      const [{ classes, work: items }, grades, posts] = await Promise.all([
        loadChildClassroom({ studentId, school, schoolYearId: childYearId, readerId: userId }),
        buildChildGrades({ studentId, school, req: gradesReq }),
        listStudentStream({ studentId, school, schoolYearId: childYearId, classId: null, readerId: userId, limit: RECENT_POSTS_WINDOW }),
      ]);
      missingRows.push(...work.needsYouMissing(items, studentId, now));
      return {
        studentId,
        name: c.name,
        grade: c.grade,
        avatar: c.avatar ?? null,
        signsIn: Boolean(c.signs_in),
        classCount: classes.length,
        dueThisWeek: work.dueWithin(items, now).length,
        missingCount: items.filter((w) => w.status === 'missing').length,
        newGradeCount: recentItems(grades, { sinceDays: NEW_GRADE_DAYS, limit: Infinity }).length,
        latestGrade: allItems(grades)[0] ?? null,
        homeroomTeacherName: c.homeroom_teacher_name ?? null,
        recentPosts: posts.slice().sort(byNewest).slice(0, RECENT_POSTS),
      };
    }));

    return ok(res, { needsYou: [...needsYou, ...missingRows.sort(newestDueFirst)], children: summaries });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to load the parent classroom summary');
    return failed(res, 500, 'Error loading the Classes page');
  }
};

// Per-child guard (after verifyParentOwnsStudent): the child's row must be
// live and in the parent's school. Sets req.child.
const requireLensChild = async (req, res, next) => {
  try {
    const child = await loadChild(req.params.studentId, req.user.school);
    if (!child) return failed(res, 404, 'Student not found');
    req.child = child;
    return next();
  } catch (error) {
    logger.error({ err: error, studentId: req.params.studentId }, 'Parent lens child check failed');
    return failed(res, 500, 'Error loading the student');
  }
};

// The read model's arguments for the lens: the child's row, the parent reading.
const lensOf = (req) => ({
  studentId: req.child.studentId,
  school: req.user.school,
  schoolYearId: req.child.schoolYearId,
  readerId: req.user.userId,
});

// GET /api/parent-portal/students/:studentId/classroom/classes
const listLensClasses = async (req, res) => {
  try {
    return ok(res, { classes: await listChildClasses(lensOf(req)) });
  } catch (error) {
    logger.error({ err: error, studentId: req.params.studentId }, 'Failed to list the lens classes');
    return failed(res, 500, 'Error loading the classes');
  }
};

// Guard for the lens's /classes/:classId/*: the child must be on the roster
// and the class not archived (404 NOT_ENROLLED). Sets req.childClass.
const requireLensClass = async (req, res, next) => {
  try {
    const header = await getChildClass({ ...lensOf(req), classId: req.params.classId });
    if (!header) return res.status(404).json(NOT_ENROLLED);
    req.childClass = header;
    return next();
  } catch (error) {
    logger.error({ err: error, classId: req.params.classId }, 'Parent lens class check failed');
    return failed(res, 500, 'Error loading the class');
  }
};

// GET /api/parent-portal/students/:studentId/classroom/classes/:classId
// The class header and what's coming up for the child (at most 3).
const getLensClass = async (req, res) => {
  try {
    const upcoming = await work.getUpcoming({ studentId: req.child.studentId, school: req.user.school, classId: req.params.classId });
    return ok(res, { class: req.childClass, upcoming });
  } catch (error) {
    return fail(res, error, 'Error loading the class', { classId: req.params.classId });
  }
};

// GET /api/parent-portal/students/:studentId/classroom/classes/:classId/classwork
// The child's Classwork exactly as the child sees it (same service, no writes).
const getLensClasswork = async (req, res) => {
  try {
    return ok(res, await work.getClasswork({ studentId: req.child.studentId, school: req.user.school, classId: req.params.classId }));
  } catch (error) {
    return fail(res, error, 'Error loading the classwork', { classId: req.params.classId });
  }
};

// GET /api/parent-portal/students/:studentId/classroom/items/:itemId
// One item with the child's work, read-only: no submission row is created
// and canEdit / canTurnIn / canUnsubmit are false.
const getLensItem = async (req, res) => {
  try {
    const item = await work.getStudentItem({
      studentId: req.child.studentId, school: req.user.school, itemId: req.params.itemId, canAct: false, open: false,
    });
    if (!item) return failed(res, 404, 'Item not found');
    return ok(res, item);
  } catch (error) {
    return fail(res, error, 'Error loading the item', { itemId: req.params.itemId });
  }
};

// GET /api/parent-portal/students/:studentId/classroom/files/:fileId/url
// A one-hour signed URL for a file of the child's own work.
const getLensFileUrl = async (req, res) => {
  try {
    const url = await work.fileUrl({ studentId: req.child.studentId, school: req.user.school, fileId: req.params.fileId });
    if (!url) return failed(res, 404, 'File not found');
    return ok(res, { url });
  } catch (error) {
    return fail(res, error, 'Could not open the file', { fileId: req.params.fileId });
  }
};

// GET /api/parent-portal/students/:studentId/classroom/classes/:classId/stream?limit=30
// The parent is the reader, so read and ackedAt are the parent's own.
const getLensStream = async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || STREAM_LIMIT, 1), MAX_STREAM_LIMIT);
  try {
    return ok(res, await getChildStream({ ...lensOf(req), classId: req.params.classId, limit }));
  } catch (error) {
    logger.error({ err: error, classId: req.params.classId }, 'Failed to load the lens stream');
    return failed(res, 500, 'Error loading the class stream');
  }
};

// GET /api/parent-portal/students/:studentId/classroom/grades?termId=
// The same function and numbers as the student's own /api/student/grades.
const getLensGrades = async (req, res) => {
  if (!isTermParamValid(req.query.termId)) return failed(res, 400, 'Invalid term');
  try {
    return ok(res, await buildChildGrades({ studentId: req.child.studentId, school: req.user.school, req }));
  } catch (error) {
    logger.error({ err: error, studentId: req.params.studentId }, 'Failed to load the lens grades');
    return failed(res, 500, 'Error loading the grades');
  }
};

// ── Email preferences (T21) ─────────────────────────────────────────────

const FREQUENCIES = ['weekly', 'daily'];
const PREF_KEYS = ['weeklySummary', 'summaryFrequency', 'summaryDow', 'missingAlerts'];
const hasKey = (body, key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;

/**
 * A change to the parent's email choices: any of the four keys (the others
 * keep their saved value). summaryDow null means "the school's day".
 * @returns {{ value: object } | { error: string }}
 */
function validatePrefs(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send your email preferences' };
  if (!PREF_KEYS.some((k) => hasKey(body, k))) return { error: 'Send at least one preference to change' };
  const value = {};
  for (const key of ['weeklySummary', 'missingAlerts']) {
    if (!hasKey(body, key)) continue;
    if (typeof body[key] !== 'boolean') return { error: `${key} must be true or false` };
    value[key] = body[key];
  }
  if (hasKey(body, 'summaryFrequency')) {
    if (!FREQUENCIES.includes(body.summaryFrequency)) return { error: 'summaryFrequency must be weekly or daily' };
    value.summaryFrequency = body.summaryFrequency;
  }
  if (hasKey(body, 'summaryDow')) {
    const dow = body.summaryDow;
    if (dow !== null && !(Number.isInteger(dow) && dow >= 0 && dow <= 6)) {
      return { error: 'summaryDow must be a day from 0 (Sunday) to 6 (Saturday), or null for the school day' };
    }
    value.summaryDow = dow;
  }
  return { value };
}

// The API shape: summaryDow is the effective day (the parent's, else the school's).
const toPrefs = (p) => ({
  weeklySummary: p.weeklySummary,
  summaryFrequency: p.summaryFrequency,
  summaryDow: p.summaryDow ?? p.schoolDow,
  missingAlerts: p.missingAlerts,
  schoolDefaultDow: p.schoolDow,
});

// GET /api/parent-portal/notification-prefs
const getNotificationPrefs = async (req, res) => {
  try {
    return ok(res, toPrefs(await loadPrefs(req.user.userId, req.user.school)));
  } catch (error) {
    logger.error({ err: error, userId: req.user.userId }, 'Failed to load email preferences');
    return failed(res, 500, 'Error loading your email preferences');
  }
};

// PUT /api/parent-portal/notification-prefs  { weeklySummary?, summaryFrequency?, summaryDow?, missingAlerts? }
// Picking the school's own day stores NULL, so the summary follows the
// school if it ever changes its day.
const updateNotificationPrefs = async (req, res) => {
  const checked = validatePrefs(req.body);
  if (checked.error) return failed(res, 400, checked.error);
  const { userId, school } = req.user;
  try {
    const current = await loadPrefs(userId, school);
    const next = { ...current, ...checked.value };
    if (hasKey(checked.value, 'summaryDow') && next.summaryDow === current.schoolDow) next.summaryDow = null;
    const { rows: [saved] } = await db.query(emailQueries.upsertPrefs, [
      userId, next.weeklySummary, next.summaryFrequency, next.summaryDow, next.missingAlerts,
    ]);
    return ok(res, toPrefs({
      weeklySummary: saved.weekly_summary,
      summaryFrequency: saved.summary_frequency,
      summaryDow: saved.summary_dow,
      missingAlerts: saved.missing_alerts,
      schoolDow: current.schoolDow,
    }));
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to save email preferences');
    return failed(res, 500, 'Error saving your email preferences');
  }
};

module.exports = {
  getNotificationPrefs,
  updateNotificationPrefs,
  validatePrefs,
  getClassroomSummary,
  requireLensChild,
  listLensClasses,
  requireLensClass,
  getLensClass,
  getLensClasswork,
  getLensItem,
  getLensFileUrl,
  getLensStream,
  getLensGrades,
};
