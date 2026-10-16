// controllers/parentClassroom.controller.js
//
// The parent's Classes page (/api/parent-portal/classroom/... and
// /api/parent-portal/students/:studentId/classroom/...). requireParent runs
// for the whole router and verifyParentOwnsStudent on every per-child route,
// so a parent reads only their own children. The lens reuses the student
// portal's read model (services/classroom/childClassroom.js, childGrades.js)
// with the parent as the reader: it shows a child's classes exactly as the
// child sees them, with the parent's own read and "Got it" state.

const logger = require('../logger');
const {
  loadChild, listChildClasses, getChildClass, getChildStream, listParentChildren, listAckNeeded,
} = require('../services/classroom/childClassroom');
const { buildChildGrades, isTermParamValid, allItems, recentItems } = require('../services/classroom/childGrades');
const { listStudentStream } = require('../services/classroom/studentStream');

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

// GET /api/parent-portal/classroom/summary
// "Needs you" plus one card per child of the selected year. Grades use the
// default term of the year (the summary takes no ?termId=).
const getClassroomSummary = async (req, res) => {
  const { userId, school } = req.user;
  const schoolYearId = req.schoolYear?.schoolYearId ?? null;
  const gradesReq = { query: {}, user: req.user, schoolYear: req.schoolYear };
  try {
    const [children, needsYou] = await Promise.all([
      listParentChildren({ parentId: userId, school, schoolYearId }),
      listAckNeeded({ parentId: userId, school, schoolYearId }),
    ]);

    const summaries = await Promise.all(children.map(async (c) => {
      const studentId = c.student_id;
      const childYearId = c.school_year_id ?? schoolYearId;
      const [classes, grades, posts] = await Promise.all([
        listChildClasses({ studentId, school, schoolYearId: childYearId, readerId: userId }),
        buildChildGrades({ studentId, school, req: gradesReq }),
        listStudentStream({ studentId, school, schoolYearId: childYearId, classId: null, readerId: userId, limit: RECENT_POSTS_WINDOW }),
      ]);
      return {
        studentId,
        name: c.name,
        grade: c.grade,
        avatar: c.avatar ?? null,
        signsIn: Boolean(c.signs_in),
        classCount: classes.length,
        dueThisWeek: 0, // T15
        missingCount: 0, // T15
        newGradeCount: recentItems(grades, { sinceDays: NEW_GRADE_DAYS, limit: Infinity }).length,
        latestGrade: allItems(grades)[0] ?? null,
        homeroomTeacherName: c.homeroom_teacher_name ?? null,
        recentPosts: posts.slice().sort(byNewest).slice(0, RECENT_POSTS),
      };
    }));

    return ok(res, { needsYou, children: summaries });
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
const getLensClass = (req, res) => ok(res, { class: req.childClass, upcoming: [] }); // upcoming: T15

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

module.exports = {
  getClassroomSummary,
  requireLensChild,
  listLensClasses,
  requireLensClass,
  getLensClass,
  getLensStream,
  getLensGrades,
};
