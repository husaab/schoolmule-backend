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
  loadChild, loadChildClassroom, listChildClasses, getChildClass, getChildStream,
} = require('../services/classroom/childClassroom');
const { buildChildGrades, newGradesFor, isTermParamValid } = require('../services/classroom/childGrades');
const work = require('../services/classroom/studentWork');

const ok = (res, data, status = 200) => res.status(status).json({ status: 'success', data });
const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });

/** A service error (httpError, maybe with a code) answers as itself; anything else is logged as a 500. */
function fail(res, error, userMessage, context) {
  if (error && error.expose && error.status) {
    return res.status(error.status).json({ status: 'failed', message: error.message, ...(error.code ? { code: error.code } : {}) });
  }
  logger.error({ err: error, ...context }, userMessage);
  return failed(res, 500, userMessage);
}

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
    const { studentId, name, firstName, grade, schoolYearId } = req.student;
    const [{ rows }, { rows: [shown] }, schoolInfo, settings] = await Promise.all([
      db.query(q.selectStudentUserEmail, [userId]),
      db.query(q.selectStudentDisplayAvatar, [studentId]),
      loadSchoolInfo(school),
      getSettings(school),
    ]);
    const login = rows[0];
    return ok(res, {
      // avatar: what Home shows (the student's own pick over the teacher-set one).
      student: { studentId, name, firstName, grade, avatar: shown?.avatar ?? null },
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
// Who is signed in, what's due soon (assigned work due within 7 days, at most
// 5) and missing (at most 3, newest due first), new grades (published in the
// last 14 days, default term of the year; home takes no ?termId=) and the
// class cards. Due soon, missing and the cards count from the same work rows.
const getHome = async (req, res) => {
  const me = self(req);
  const gradesReq = { query: {}, user: req.user, schoolYear: req.schoolYear };
  try {
    const now = new Date();
    const [child, newGrades, { classes, work: items }] = await Promise.all([
      loadChild(me.studentId, me.school),
      newGradesFor({ studentId: me.studentId, school: me.school, req: gradesReq }),
      loadChildClassroom(me),
    ]);
    const { studentId, name, firstName, grade } = req.student;
    return ok(res, {
      student: { studentId, name, firstName, grade, avatar: child?.avatar ?? null },
      dueSoon: work.dueSoonOf(items, now),
      missing: work.homeMissingOf(items),
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
// The class header and what's coming up in it (at most 3).
const getClass = async (req, res) => {
  try {
    const upcoming = await work.getUpcoming({ studentId: req.student.studentId, school: req.user.school, classId: req.params.classId });
    return ok(res, { class: req.childClass, upcoming });
  } catch (error) {
    return fail(res, error, 'Error loading the class', { classId: req.params.classId });
  }
};

// GET /api/student/classes/:classId/classwork
// The class's topics (those holding something the student can see), items
// with the student's status, and what's coming up.
const getClasswork = async (req, res) => {
  try {
    return ok(res, await work.getClasswork({ studentId: req.student.studentId, school: req.user.school, classId: req.params.classId }));
  } catch (error) {
    return fail(res, error, 'Error loading the classwork', { classId: req.params.classId });
  }
};

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

// ── Classwork: the To-do, an item, and the student's own work ─────────────

const TODO_TABS = ['assigned', 'missing', 'done'];
const ITEM_NOT_FOUND = 'Item not found';

// The caller's own row: every work query keys on it, never on a client id.
const mine = (req, extra = {}) => ({ studentId: req.student.studentId, school: req.user.school, ...extra });

// GET /api/student/todo?tab=assigned|missing|done&classId=
// Counts per tab and the tab's groups (current-term classes; classId narrows both).
const getTodo = async (req, res) => {
  const tab = req.query.tab ? String(req.query.tab) : 'assigned';
  if (!TODO_TABS.includes(tab)) return failed(res, 400, 'tab must be assigned, missing or done');
  const classId = req.query.classId ? String(req.query.classId).toLowerCase() : null;
  if (classId && !UUID_RE.test(classId)) return failed(res, 400, 'Invalid class id');
  try {
    return ok(res, await work.getTodo(mine(req, { schoolYearId: req.student.schoolYearId, tab, classId })));
  } catch (error) {
    return fail(res, error, 'Error loading your to-do list', { userId: req.user.userId });
  }
};

// GET /api/student/items/:itemId
// The item page. Opening a turn-in item creates the student's submission on
// first open (opened_at); an admin's read-only preview writes nothing.
const getItem = async (req, res) => {
  try {
    const item = await work.getStudentItem(mine(req, {
      itemId: req.params.itemId, canAct: true, open: !req.user.impersonator,
    }));
    if (!item) return failed(res, 404, ITEM_NOT_FOUND);
    return ok(res, item);
  } catch (error) {
    return fail(res, error, 'Error loading the item', { itemId: req.params.itemId });
  }
};

/** The item as it stands after a change (the reply to turn in and unsubmit). */
const itemReply = async (req, res) => {
  const item = await work.getStudentItem(mine(req, { itemId: req.params.itemId, canAct: true, open: false }));
  if (!item) return failed(res, 404, ITEM_NOT_FOUND);
  return ok(res, item);
};

// PUT /api/student/items/:itemId/text  { textAnswer }  (autosave, ≤ 20 000 characters)
const saveText = async (req, res) => {
  if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'textAnswer')) return failed(res, 400, 'Send textAnswer');
  const parsed = work.parseTextAnswer(req.body.textAnswer);
  if (parsed.error) return failed(res, 400, parsed.error);
  try {
    return ok(res, await work.saveText(mine(req, { itemId: req.params.itemId, text: parsed.value })));
  } catch (error) {
    return fail(res, error, 'Error saving your answer', { itemId: req.params.itemId });
  }
};

// Guard for POST …/files, before the upload is read: the item is the
// student's, takes files, and is still open to changes.
const requireUploadableItem = async (req, res, next) => {
  try {
    await work.checkUploadable(mine(req, { itemId: req.params.itemId }));
    return next();
  } catch (error) {
    return fail(res, error, 'Error checking the item', { itemId: req.params.itemId });
  }
};

// POST /api/student/items/:itemId/files  multipart "files" (≤ 5 × 10 MB)
// Replies with every file of the student's work on the item.
const uploadFiles = async (req, res) => {
  try {
    const files = await work.addFiles(mine(req, { itemId: req.params.itemId, userId: req.user.userId, files: req.files }));
    return ok(res, { files }, 201);
  } catch (error) {
    return fail(res, error, 'Error uploading your files', { itemId: req.params.itemId });
  }
};

// DELETE /api/student/files/:fileId  (own file, not turned in)
const deleteFile = async (req, res) => {
  try {
    return ok(res, await work.deleteFile(mine(req, { fileId: req.params.fileId })));
  } catch (error) {
    return fail(res, error, 'Error removing the file', { fileId: req.params.fileId });
  }
};

// GET /api/student/files/:fileId/url  (signed for an hour)
const fileUrl = async (req, res) => {
  try {
    const url = await work.fileUrl(mine(req, { fileId: req.params.fileId }));
    if (!url) return failed(res, 404, 'File not found');
    return ok(res, { url });
  } catch (error) {
    return fail(res, error, 'Could not open the file', { fileId: req.params.fileId });
  }
};

// POST /api/student/items/:itemId/turn-in
const turnIn = async (req, res) => {
  try {
    await work.turnIn(mine(req, { itemId: req.params.itemId }));
    return await itemReply(req, res);
  } catch (error) {
    return fail(res, error, 'Error turning in your work', { itemId: req.params.itemId });
  }
};

// POST /api/student/items/:itemId/unsubmit
const unsubmit = async (req, res) => {
  try {
    await work.unsubmit(mine(req, { itemId: req.params.itemId }));
    return await itemReply(req, res);
  } catch (error) {
    return fail(res, error, 'Error unsubmitting your work', { itemId: req.params.itemId });
  }
};

module.exports = {
  getMe, listAnnouncements, requireStudentAnnouncement, markAnnouncementRead, announcementAttachmentUrl,
  getHome, listClasses, requireEnrolledClass, getClass, getClasswork, getClassStream, getClassPeople, getGrades,
  getTodo, getItem, saveText, requireUploadableItem, uploadFiles, deleteFile, fileUrl, turnIn, unsubmit,
};
