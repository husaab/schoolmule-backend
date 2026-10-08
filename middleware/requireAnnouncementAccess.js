// middleware/requireAnnouncementAccess.js
//
// Guards /api/announcements/:id/*. Audience membership is derived at request
// time by selectAnnouncementAccess (never stored). Unknown id or another
// school → 404; malformed id → 403; a removed announcement → 410 on GET so
// the UI can say "removed" behind an old email link, 404 for anything else.
//
// On success: req.announcement (see accessRowToAnnouncement).

const db = require('../config/database');
const logger = require('../logger');
const q = require('../queries/announcement.queries');

const NOT_FOUND = { status: 'failed', message: 'Announcement not found' };
const NOT_AUTHORIZED = { status: 'failed', message: 'Not authorized for this announcement' };
const REMOVED = { status: 'failed', code: 'REMOVED', message: 'This announcement was removed' };

const accessRowToAnnouncement = (r) => ({
  announcementId: r.announcement_id,
  school: r.school,
  schoolYearId: r.school_year_id,
  scope: r.scope,
  classId: r.class_id,
  classSubject: r.class_subject ?? null,
  classGrade: r.class_grade ?? null,
  grade: r.grade,
  title: r.title,
  body: r.body,
  authorId: r.author_id,
  authorRole: r.author_role,
  authorName: r.author_name || 'SchoolMule',
  publishedAt: r.published_at,
  pinnedUntil: r.pinned_until,
  isPinned: Boolean(r.is_pinned),
  editedAt: r.edited_at,
  deletedAt: r.deleted_at,
  attachmentCount: r.attachment_count ?? 0,
  isAuthor: Boolean(r.is_author),
});

const isVisible = (row, user) =>
  user.role === 'ADMIN' ||
  Boolean(row.is_author) ||
  (user.role === 'TEACHER' && Boolean(row.is_class_teacher)) ||
  (user.role === 'PARENT' && Boolean(row.is_guardian));

/** Author or admin may edit / remove. */
const canMutate = (ann, user) => user.role === 'ADMIN' || ann.isAuthor;

const requireAnnouncementAccess = async (req, res, next) => {
  try {
    const { rows } = await db.query(q.selectAnnouncementAccess, [req.params.id, req.user.userId]);
    const row = rows[0];
    if (!row || row.school !== req.user.school) return res.status(404).json(NOT_FOUND);
    if (!isVisible(row, req.user)) return res.status(403).json(NOT_AUTHORIZED);
    if (row.deleted_at) return req.method === 'GET' ? res.status(410).json(REMOVED) : res.status(404).json(NOT_FOUND);
    req.announcement = accessRowToAnnouncement(row);
    return next();
  } catch (error) {
    logger.error('Error verifying announcement access:', error);
    return res.status(403).json(NOT_AUTHORIZED);
  }
};

module.exports = requireAnnouncementAccess;
module.exports.accessRowToAnnouncement = accessRowToAnnouncement;
module.exports.canMutate = canMutate;
