/*
  controllers/studentPortal.controller.js
  The student portal API (/api/student). requireStudent runs first: every
  handler reads the caller's own student row from req.student and never takes
  a student id from the client.
*/

const db = require('../config/database');
const supabase = require('../config/supabaseClient');
const logger = require('../logger');
const q = require('../queries/studentAccount.queries');
const announcementQueries = require('../queries/announcement.queries');
const { listStudentStream, studentAnnouncementRefusal } = require('../services/classroom/studentStream');
const { BUCKET, SIGNED_URL_TTL } = require('../utils/attachmentUpload');
const { getSettings } = require('../services/classroom/classroomSettings');
const { photoUrlFor } = require('../services/profile/photos');
const { loadSchoolInfo } = require('../services/classroom/studentAccounts');
const { getSchoolName } = require('../utils/schoolUtils');
const {
  loadChild, listChildClasses, getChildClass, getChildStream,
} = require('../services/classroom/childClassroom');
const { buildChildGrades, newGradesFor, isTermParamValid } = require('../services/classroom/childGrades');

const ok = (res, data) => res.status(200).json({ status: 'success', data });
const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEED_LIMIT = 30;
const MAX_FEED_LIMIT = 100;

const feedLimit = (value) => Math.min(Math.max(Number.parseInt(value, 10) || FEED_LIMIT, 1), MAX_FEED_LIMIT);
const NOT_ENROLLED = { status: 'failed', code: 'NOT_ENROLLED', message: "You aren't in this class" };

// GET /api/student/me
// Who is signed in: the student row for the request year, the login, the
// school and the settings the portal shell needs.
const getMe = async (req, res) => {
  const { school, userId } = req.user;
  try {
    const [{ rows }, schoolInfo, settings] = await Promise.all([
      db.query(q.selectStudentUserEmail, [userId]),
      loadSchoolInfo(school),
      getSettings(school),
    ]);
    const { studentId, name, firstName, grade, schoolYearId } = req.student;
    const login = rows[0];
    return ok(res, {
      student: { studentId, name, firstName, grade },
      user: {
        userId,
        email: login?.email ?? req.user.email ?? null,
        avatar: login?.avatar ?? null,
        photoUrl: await photoUrlFor({ photo_path: login?.photo_path, role: 'STUDENT', school }),
      },
      school: { code: school, name: (schoolInfo && schoolInfo.name) || getSchoolName(String(school)) },
      settings: { studentPhotos: settings.studentPhotos },
      schoolYear: { schoolYearId, label: req.schoolYear?.label ?? null },
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load the student portal profile');
    return failed(res, 500, 'Error loading your account');
  }
};

// GET /api/student/announcements?classId=&limit=30
// The student's Stream: every announcement whose audience includes them
// (class, grade, school or hand-picked), optionally one class's only.
const listAnnouncements = async (req, res) => {
  const classId = req.query.classId || null;
  if (classId && !UUID_RE.test(String(classId))) return failed(res, 400, 'Invalid class id');
  const limit = feedLimit(req.query.limit);
  try {
    const items = await listStudentStream({
      studentId: req.student.studentId,
      school: req.user.school,
      schoolYearId: req.student.schoolYearId,
      classId,
      readerId: req.user.userId,
      limit,
    });
    return ok(res, { items });
  } catch (error) {
    logger.error({ err: error, userId: req.user.userId }, 'Failed to load the student stream');
    return failed(res, 500, 'Error loading announcements');
  }
};

// Guard for /announcements/:id/*: the post must be in this student's audience
// (404 otherwise, never revealing it exists) and not removed (410).
const requireStudentAnnouncement = async (req, res, next) => {
  try {
    const refusal = await studentAnnouncementRefusal({
      announcementId: req.params.id,
      studentId: req.student.studentId,
      schoolYearId: req.student.schoolYearId,
      school: req.user.school,
    });
    if (refusal) return res.status(refusal.status).json(refusal.body);
    return next();
  } catch (error) {
    logger.error({ err: error, announcementId: req.params.id }, 'Student announcement access check failed');
    return failed(res, 500, 'Error loading the announcement');
  }
};

// POST /api/student/announcements/:id/read
const markAnnouncementRead = async (req, res) => {
  try {
    await db.query(announcementQueries.upsertRead, [req.params.id, req.user.userId]);
    return ok(res, { read: true });
  } catch (error) {
    logger.error({ err: error, announcementId: req.params.id }, 'Failed to mark a student announcement read');
    return failed(res, 500, 'Error updating the announcement');
  }
};

// GET /api/student/announcements/:id/attachments/:attachmentId/url
// A one-hour signed URL for a file of a post the student can see.
const announcementAttachmentUrl = async (req, res) => {
  try {
    const { rows } = await db.query(announcementQueries.selectAttachment, [req.params.attachmentId, req.params.id]);
    if (!rows.length) return failed(res, 404, 'Attachment not found');
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(rows[0].file_path, SIGNED_URL_TTL);
    if (error || !data?.signedUrl) return failed(res, 500, 'Could not open the attachment');
    return ok(res, { url: data.signedUrl });
  } catch (error) {
    logger.error({ err: error, announcementId: req.params.id }, 'Failed to sign a student announcement attachment');
    return failed(res, 500, 'Could not open the attachment');
  }
};

// The read model's arguments for the caller's own student row.
const self = (req) => ({
  studentId: req.student.studentId,
  school: req.user.school,
  schoolYearId: req.student.schoolYearId,
  readerId: req.user.userId,
});

// GET /api/student/home
// Who is signed in, new grades (published in the last 14 days, default term
// of the year; home takes no ?termId=) and the class cards. dueSoon and
// missing are classwork (T15).
const getHome = async (req, res) => {
  const me = self(req);
  const gradesReq = { query: {}, user: req.user, schoolYear: req.schoolYear };
  try {
    const [child, newGrades, classes] = await Promise.all([
      loadChild(me.studentId, me.school),
      newGradesFor({ studentId: me.studentId, school: me.school, req: gradesReq }),
      listChildClasses(me),
    ]);
    const { studentId, name, firstName, grade } = req.student;
    return ok(res, {
      student: { studentId, name, firstName, grade, avatar: child?.avatar ?? null },
      dueSoon: [],
      missing: [],
      newGrades,
      classes,
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user.userId }, 'Failed to load the student home');
    return failed(res, 500, 'Error loading your home page');
  }
};

// GET /api/student/classes
const listClasses = async (req, res) => {
  try {
    return ok(res, { classes: await listChildClasses(self(req)) });
  } catch (error) {
    logger.error({ err: error, userId: req.user.userId }, 'Failed to list the student classes');
    return failed(res, 500, 'Error loading your classes');
  }
};

// Guard for /classes/:classId/*: the student must be on the class's roster and
// the class not archived (404 NOT_ENROLLED otherwise). Sets req.childClass.
const requireEnrolledClass = async (req, res, next) => {
  try {
    const header = await getChildClass({ ...self(req), classId: req.params.classId });
    if (!header) return res.status(404).json(NOT_ENROLLED);
    req.childClass = header;
    return next();
  } catch (error) {
    logger.error({ err: error, classId: req.params.classId }, 'Student class check failed');
    return failed(res, 500, 'Error loading the class');
  }
};

// GET /api/student/classes/:classId
// The class header. upcoming is classwork (T15).
const getClass = (req, res) => ok(res, { class: req.childClass, upcoming: [] });

// GET /api/student/classes/:classId/stream?limit=30
const getClassStream = async (req, res) => {
  try {
    return ok(res, await getChildStream({ ...self(req), classId: req.params.classId, limit: feedLimit(req.query.limit) }));
  } catch (error) {
    logger.error({ err: error, classId: req.params.classId }, 'Failed to load the student class stream');
    return failed(res, 500, 'Error loading the class stream');
  }
};

// GET /api/student/classes/:classId/people: the teachers, never classmates.
// requireEnrolledClass already loaded them (getChildClass's teachers are
// getChildPeople's), so they are not read and signed a second time.
const getClassPeople = (req, res) => ok(res, { teachers: req.childClass.teachers });

// GET /api/student/grades?termId=
// Published grades only, from the shared grade engine (the parent portal's path).
const getGrades = async (req, res) => {
  if (!isTermParamValid(req.query.termId)) return failed(res, 400, 'Invalid term');
  try {
    return ok(res, await buildChildGrades({ studentId: req.student.studentId, school: req.user.school, req }));
  } catch (error) {
    logger.error({ err: error, userId: req.user.userId }, 'Failed to load the student grades');
    return failed(res, 500, 'Error loading your grades');
  }
};

module.exports = {
  getMe, listAnnouncements, requireStudentAnnouncement, markAnnouncementRead, announcementAttachmentUrl,
  getHome, listClasses, requireEnrolledClass, getClass, getClassStream, getClassPeople, getGrades,
};
