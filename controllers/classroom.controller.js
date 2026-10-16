/*
  controllers/classroom.controller.js
  The teacher's classroom API (/api/classroom). requireStaff runs for the
  whole router and requireClassOwnership on every :classId route, so a
  teacher reaches only classes they teach (admins reach any class of their
  school). Student actions also require the student to be on that class's
  roster: a teacher manages only their own students' logins and avatars.
*/

const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const supabase = require('../config/supabaseClient');
const logger = require('../logger');
const q = require('../queries/studentAccount.queries');
const identityQueries = require('../queries/classIdentity.queries');
const classroomQueries = require('../queries/classroom.queries');
const announcementQueries = require('../queries/announcement.queries');
const { toListItem } = require('./announcement.controller');
const { parseStudentIds, resendInviteFor, resetPasswordFor } = require('../services/classroom/studentAccounts');
const { BANNER_BUCKET, identityOf, optionsOf, removeBannerObject } = require('../services/classroom/classView');
const {
  toClassCard, toHeaderClass, toComingUpRow, toDraftRow, toNotice, toTeacher, toPeopleStudent, peopleCounts,
} = require('../services/classroom/classCards');
const { getSettings } = require('../services/classroom/classroomSettings');
const { signedPhotoUrl } = require('../services/profile/photos');
const { isFamily, isColor } = require('../utils/classIdentity');
const { AVATAR_ERROR, validateAvatar } = require('../utils/avatar');
const { sendQrCards } = require('./studentAccount.controller');

const ok = (res, data) => res.status(200).json({ status: 'success', data });
const failed = (res, status, message) => res.status(status).json({ status: 'failed', message });

const isAdminUser = (req) => req.user.role === 'ADMIN';

/** The class's teachers (lead first) with signed photo URLs, for the header and People. */
async function loadTeachers(classId) {
  const { rows } = await db.query(classroomQueries.selectClassTeachers, [classId]);
  return Promise.all(rows.map(async (row) => toTeacher(row, await signedPhotoUrl(row.photo_path))));
}

// GET /api/classroom/classes?archived=1
// The Classes home: the caller's class cards for the year, what is coming up
// across them, their drafts and scheduled items, and (T16) the review list.
// Archived classes are left out unless archived=1.
const listClasses = async (req, res) => {
  const { userId, school, role } = req.user;
  const yearId = req.schoolYear?.schoolYearId ?? null;
  const includeArchived = ['1', 'true'].includes(String(req.query.archived));
  // toReview is T16's TO_REVIEW; empty until then.
  const empty = { classes: [], toReview: [], comingUp: [], draftsAndScheduled: [] };
  if (!yearId) return ok(res, empty);
  try {
    const [cardRows, comingRows, draftRows] = await Promise.all([
      db.query(classroomQueries.selectClassCards, [userId, school, role, yearId, includeArchived]),
      db.query(classroomQueries.COMING_UP, [userId, school, role, yearId, null]),
      db.query(classroomQueries.DRAFTS_AND_SCHEDULED, [userId, school, yearId]),
    ]);
    return ok(res, {
      ...empty,
      classes: cardRows.rows.map(toClassCard),
      comingUp: comingRows.rows.map(toComingUpRow),
      draftsAndScheduled: draftRows.rows.map(toDraftRow),
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to list the classroom classes');
    return failed(res, 500, 'Error loading your classes');
  }
};

// GET /api/classroom/classes/:classId
// The class header. An archived class is still returned (with archivedAt) so
// it can be reopened and unarchived; only the list hides archived classes.
const getClass = async (req, res) => {
  const { classId, school } = req.class;
  try {
    const [cardRes, teachers, settings] = await Promise.all([
      db.query(classroomQueries.selectClassCard, [classId]),
      loadTeachers(classId),
      getSettings(school),
    ]);
    const row = cardRes.rows[0];
    if (!row) return failed(res, 404, 'Class not found');
    const isAdmin = isAdminUser(req);
    // Advisory, for hiding controls: a past school year is read-only for teachers. The server enforces
    // that only for requests made in a past year (resolveSchoolYear), not for a past-year class by id.
    // requireClassOwnership has already let only an admin or this class's lead or co-teacher through.
    // Deleting follows editing: every teacher of a current-year class may delete it, as on /classes.
    const canEdit = isAdmin || row.year_is_active !== false;
    return ok(res, {
      class: toHeaderClass(row),
      teachers,
      permissions: { canEdit, canDelete: canEdit, isAdmin },
      settings: {
        parentsReadPrivateComments: settings.parentsReadPrivateComments,
        studentPhotos: settings.studentPhotos,
        enabled: settings.enabled,
      },
    });
  } catch (error) {
    logger.error({ err: error, classId }, 'Failed to load the class header');
    return failed(res, 500, 'Error loading the class');
  }
};

// GET /api/classroom/classes/:classId/people
// Teachers and the student roster with each login's status and the parents on
// file. Inviting is the admin's; teachers reset, resend and print cards.
const getPeople = async (req, res) => {
  const { classId, school } = req.class;
  try {
    const [teachers, studentRes, settings] = await Promise.all([
      loadTeachers(classId),
      db.query(classroomQueries.selectPeopleStudents, [classId]),
      getSettings(school),
    ]);
    const students = studentRes.rows.map((row) => toPeopleStudent(row, settings));
    return ok(res, {
      teachers,
      students,
      counts: peopleCounts(students),
      canInvite: isAdminUser(req),
      canManageAccounts: true,
    });
  } catch (error) {
    logger.error({ err: error, classId }, 'Failed to load the class people');
    return failed(res, 500, 'Error loading the class roster');
  }
};

const STREAM_LIMIT = 50;

// GET /api/classroom/classes/:classId/stream
// The class Stream for staff: this class's posts (pinned first, then newest)
// with guardian and student seen counts, what is coming up in the class, and
// who a new post would email. Posts are not limited to the selected year (the
// class id already scopes them), so a past-year class still shows its own.
// notices are the class's posted assignments, quizzes and materials.
const getStream = async (req, res) => {
  const { classId, school } = req.class;
  const { userId, role } = req.user;
  const yearId = req.schoolYear?.schoolYearId ?? null;
  try {
    const [postRes, comingRes, previewRes, noticeRes] = await Promise.all([
      // Any scope with this class: class posts, and custom posts composed in this
      // class's Stream (their audience stays the picked students).
      db.query(announcementQueries.listAnnouncements, [
        userId, school, role, null, classId, null, null, null, false, false, null, null, STREAM_LIMIT,
      ]),
      yearId ? db.query(classroomQueries.COMING_UP, [userId, school, role, yearId, classId]) : Promise.resolve({ rows: [] }),
      db.query(announcementQueries.selectAudiencePreview, [school, 'class', classId, null, yearId, null]),
      db.query(classroomQueries.STREAM_NOTICES, [classId]),
    ]);
    const p = previewRes.rows[0] || {};
    return ok(res, {
      announcements: postRes.rows.map((r) => toListItem(r, req.user)),
      notices: noticeRes.rows.map(toNotice),
      upcoming: comingRes.rows.map(toComingUpRow),
      audience: {
        students: p.students_with_account ?? 0,
        guardians: (p.guardians_with_account ?? 0) + (p.guardians_invite_pending ?? 0) + (p.guardians_email_only ?? 0),
      },
    });
  } catch (error) {
    logger.error({ err: error, classId }, 'Failed to load the class stream');
    return failed(res, 500, 'Error loading the class stream');
  }
};

// GET /api/classroom/settings: the school's classroom settings, read-only, for staff UI copy.
const getClassroomSettings = async (req, res) => {
  try {
    const s = await getSettings(req.user.school);
    return ok(res, {
      enabled: s.enabled,
      loginFromGrade: s.loginFromGrade,
      qrUntilGrade: s.qrUntilGrade,
      parentsReadPrivateComments: s.parentsReadPrivateComments,
      studentPhotos: s.studentPhotos,
    });
  } catch (error) {
    logger.error({ err: error, school: req.user.school }, 'Failed to load the classroom settings');
    return failed(res, 500, 'Error loading the classroom settings');
  }
};

/** The subset of these student ids on the class roster. */
async function enrolledIn(classId, studentIds) {
  const { rows } = await db.query(q.selectEnrolledStudentIds, [classId, studentIds]);
  return new Set(rows.map((r) => r.student_id));
}

// One student's login action, for a student on the class roster.
const studentAccountAction = (run, what) => async (req, res) => {
  const { school, username } = req.user;
  const { classId } = req.params;
  const studentId = req.params.studentId.toLowerCase();
  try {
    if (!(await enrolledIn(classId, [studentId])).has(studentId)) {
      return failed(res, 403, "This student isn't in this class");
    }
    const { rows } = await db.query(q.selectStudentAccountRow, [school, studentId]);
    const row = rows[0];
    if (!row) return failed(res, 404, 'Student not found');
    if (!row.user_id) return failed(res, 400, "This student doesn't have an account yet");

    const result = await run(row, { school, by: username });
    return result.sent ? ok(res, { sent: true }) : failed(res, result.status, result.message);
  } catch (error) {
    logger.error({ err: error, classId, studentId }, `Failed to ${what}`);
    return failed(res, 500, `Error trying to ${what}`);
  }
};

// POST /api/classroom/classes/:classId/students/:studentId/reset-password
const resetStudentPassword = studentAccountAction(
  (row, { school, by }) => resetPasswordFor(row, { school, requestedBy: by }),
  "send a student's password link",
);

// POST /api/classroom/classes/:classId/students/:studentId/resend-invite
const resendStudentInvite = studentAccountAction(
  (row, { school, by }) => resendInviteFor(row, { school, invitedBy: by }),
  "resend a student's invite",
);

// POST /api/classroom/classes/:classId/qr-cards.pdf  { studentIds }
// Every student must be on this class's roster (403 otherwise). Printing
// always reissues: each printed card voids that student's older one.
const printClassQrCards = async (req, res) => {
  const parsed = parseStudentIds(req.body?.studentIds);
  if (parsed.error) return failed(res, 400, parsed.error);
  try {
    const enrolled = await enrolledIn(req.params.classId, parsed.ids);
    if (parsed.ids.some((id) => !enrolled.has(id))) {
      return failed(res, 403, "Some of these students aren't in this class");
    }
    return await sendQrCards(res, { school: req.user.school, studentIds: parsed.ids, requestedBy: req.user.userId });
  } catch (error) {
    logger.error({ err: error, classId: req.params.classId }, 'Failed to print class QR cards');
    return failed(res, 500, 'Error printing the QR cards');
  }
};

const has = (body, key) => Boolean(body) && Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;

/** Delete an upload nothing points at any more (a duplicate or a rolled-over copy may share it). */
async function removeBannerIfUnused(path) {
  if (!path) return;
  try {
    const { rows } = await db.query(identityQueries.selectBannerReference, [path]);
    if (rows.length === 0) await removeBannerObject(path);
  } catch (error) {
    logger.warn({ path, err: error?.message || error }, 'Checking a class banner before removing it failed');
  }
}

// The reply to every identity change: the class and its resolved identity.
const identityReply = (res, row) => ok(res, { classId: row.class_id, identity: identityOf(row) });

// PATCH /api/classroom/classes/:classId/identity  { bannerKey?, iconKey?, color? }
// A key set to null goes back to the subject default. Choosing a banner drops
// any uploaded one.
const updateIdentity = async (req, res) => {
  const body = req.body || {};
  const set = { banner: has(body, 'bannerKey'), icon: has(body, 'iconKey'), color: has(body, 'color') };
  if (!set.banner && !set.icon && !set.color) {
    return failed(res, 400, 'Send a bannerKey, iconKey or color');
  }
  if (set.banner && body.bannerKey !== null && !isFamily(body.bannerKey)) return failed(res, 400, 'Choose a banner from the library');
  if (set.icon && body.iconKey !== null && !isFamily(body.iconKey)) return failed(res, 400, 'Choose an icon from the library');
  if (set.color && body.color !== null && !isColor(body.color)) return failed(res, 400, 'Choose a color from the palette');

  try {
    const { rows } = await db.query(identityQueries.updateIdentity, [
      req.class.classId,
      set.banner, set.banner ? body.bannerKey : null,
      set.icon, set.icon ? body.iconKey : null,
      set.color, set.color ? body.color : null,
    ]);
    if (!rows[0]) return failed(res, 404, 'Class not found');
    if (set.banner) await removeBannerIfUnused(rows[0].old_banner_path);
    return identityReply(res, rows[0]);
  } catch (error) {
    logger.error({ err: error, classId: req.class.classId }, 'Failed to update the class identity');
    return failed(res, 500, 'Error updating the class look');
  }
};

// POST /api/classroom/classes/:classId/banner  (multipart "banner")
// The file goes to the public school-assets bucket first; the row changes only
// once the upload succeeded, and the replaced upload is removed afterwards.
const uploadBanner = async (req, res) => {
  const { classId, school } = req.class;
  const { buffer, contentType, ext } = req.image;
  const path = `${school}/class-banners/${classId}/${uuidv4()}.${ext}`;

  try {
    const { error } = await supabase.storage.from(BANNER_BUCKET).upload(path, buffer, { contentType, upsert: false });
    if (error) throw error;
  } catch (error) {
    logger.error({ err: error, classId }, 'Failed to store a class banner');
    return failed(res, 500, 'Error uploading the banner');
  }

  try {
    const { rows } = await db.query(identityQueries.setBannerPath, [classId, path]);
    if (!rows[0]) {
      await removeBannerObject(path);
      return failed(res, 404, 'Class not found');
    }
    await removeBannerIfUnused(rows[0].old_banner_path);
    return identityReply(res, rows[0]);
  } catch (error) {
    await removeBannerObject(path);
    logger.error({ err: error, classId }, 'Failed to save a class banner');
    return failed(res, 500, 'Error saving the banner');
  }
};

const resetter = (query, what) => async (req, res) => {
  const { classId } = req.class;
  try {
    const { rows } = await db.query(query, [classId]);
    if (!rows[0]) return failed(res, 404, 'Class not found');
    await removeBannerIfUnused(rows[0].old_banner_path);
    return identityReply(res, rows[0]);
  } catch (error) {
    logger.error({ err: error, classId }, `Failed to ${what}`);
    return failed(res, 500, `Error trying to ${what}`);
  }
};

// DELETE /api/classroom/classes/:classId/banner: back to the family banner.
const deleteBanner = resetter(identityQueries.clearBanner, 'remove the class banner');

// POST /api/classroom/classes/:classId/identity/reset: banner, icon and color all back to the subject default.
const resetIdentity = resetter(identityQueries.resetIdentity, 'reset the class look');

// PATCH /api/classroom/classes/:classId/options  { acceptLate?, emailNewPosts?, showClassAverage? }
const updateOptions = async (req, res) => {
  const body = req.body || {};
  const keys = ['acceptLate', 'emailNewPosts', 'showClassAverage'];
  if (!keys.some((k) => has(body, k))) return failed(res, 400, 'Send acceptLate, emailNewPosts or showClassAverage');
  for (const k of keys) {
    if (has(body, k) && typeof body[k] !== 'boolean') return failed(res, 400, `${k} must be true or false`);
  }
  try {
    const { rows } = await db.query(identityQueries.updateOptions, [
      req.class.classId,
      has(body, 'acceptLate') ? body.acceptLate : null,
      has(body, 'emailNewPosts') ? body.emailNewPosts : null,
      has(body, 'showClassAverage') ? body.showClassAverage : null,
    ]);
    if (!rows[0]) return failed(res, 404, 'Class not found');
    return ok(res, { classId: rows[0].class_id, options: optionsOf(rows[0]) });
  } catch (error) {
    logger.error({ err: error, classId: req.class.classId }, 'Failed to update the class options');
    return failed(res, 500, 'Error updating the class options');
  }
};

const archiver = (archive) => async (req, res) => {
  const { classId } = req.class;
  try {
    const { rows } = archive
      ? await db.query(identityQueries.archive, [classId, req.user.userId])
      : await db.query(identityQueries.unarchive, [classId]);
    if (!rows[0]) return failed(res, 404, 'Class not found');
    return ok(res, { classId: rows[0].class_id, archivedAt: rows[0].archived_at });
  } catch (error) {
    logger.error({ err: error, classId }, `Failed to ${archive ? 'archive' : 'unarchive'} the class`);
    return failed(res, 500, `Error trying to ${archive ? 'archive' : 'unarchive'} the class`);
  }
};

// POST /api/classroom/classes/:classId/archive and /unarchive
const archiveClass = archiver(true);
const unarchiveClass = archiver(false);

// PUT /api/classroom/classes/:classId/students/:studentId/avatar  { avatar: AvatarSpec | null }
// For a child with no login of their own to pick with (JK/SK). Once the
// student has a login with an avatar, that pick is the one shown.
const setStudentAvatar = async (req, res) => {
  const { classId } = req.params;
  const studentId = req.params.studentId.toLowerCase();
  if (!has(req.body, 'avatar')) return failed(res, 400, AVATAR_ERROR);
  const parsed = validateAvatar(req.body.avatar);
  if (parsed.error) return failed(res, 400, parsed.error);
  try {
    if (!(await enrolledIn(classId, [studentId])).has(studentId)) {
      return failed(res, 404, "This student isn't in this class");
    }
    const { rows } = await db.query(identityQueries.updateStudentAvatar, [
      studentId, req.class.school, parsed.value === null ? null : JSON.stringify(parsed.value),
    ]);
    if (!rows[0]) return failed(res, 404, 'Student not found');
    return ok(res, { studentId: rows[0].student_id, avatar: rows[0].avatar ?? null });
  } catch (error) {
    logger.error({ err: error, classId, studentId }, "Failed to set a student's avatar");
    return failed(res, 500, "Error saving the student's avatar");
  }
};

module.exports = {
  listClasses, getClass, getPeople, getStream, getClassroomSettings,
  resetStudentPassword, resendStudentInvite, printClassQrCards,
  updateIdentity, uploadBanner, deleteBanner, resetIdentity, updateOptions,
  archiveClass, unarchiveClass, setStudentAvatar,
};
