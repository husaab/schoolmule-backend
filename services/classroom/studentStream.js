// services/classroom/studentStream.js
//
// The class Stream as a student reads it: the announcements whose derived
// audience (queries/announcement.queries.js IN_AUDIENCE) includes the student,
// with attachment metadata, the author as a PersonLite, and the reader's own
// read and "Got it" state. The student portal reads it with the student as the
// reader; the parent lens (T12) reads it with the parent as the reader, so the
// two views can never disagree about what a child's Stream holds.

const db = require('../../config/database');
const q = require('../../queries/announcement.queries');
const { signedPhotoUrl } = require('../profile/photos');

const REMOVED = { status: 'failed', code: 'REMOVED', message: 'This announcement was removed' };
const NOT_FOUND = { status: 'failed', message: 'Announcement not found' };

/** listStudentAnnouncements row → StudentAnnouncement. */
function toStudentAnnouncement(row, attachments = [], photoUrl = null) {
  return {
    announcementId: row.announcement_id,
    scope: row.scope,
    classId: row.class_id ?? null,
    classSubject: row.class_subject ?? null,
    title: row.title,
    body: row.body,
    author: {
      userId: row.author_id ?? null,
      name: row.author_name || 'SchoolMule',
      avatar: row.author_avatar ?? null,
      photoUrl: photoUrl ?? null,
    },
    publishedAt: row.published_at,
    editedAt: row.edited_at ?? null,
    isPinned: Boolean(row.is_pinned),
    attachments,
    read: Boolean(row.read),
    ackRequested: Boolean(row.ack_requested),
    ackedAt: row.acked_at ?? null,
  };
}

/** Signed photo URLs for the authors who have a photo (adults: never gated), one signing per author. */
async function authorPhotoUrls(rows) {
  const paths = new Map();
  for (const r of rows) if (r.author_id && r.author_photo_path) paths.set(r.author_id, r.author_photo_path);
  const entries = await Promise.all([...paths].map(async ([id, path]) => [id, await signedPhotoUrl(path)]));
  return new Map(entries);
}

/**
 * The Stream of one student, newest first (pinned posts on top).
 * @param {{ studentId: string, school: string, schoolYearId: string|null, classId?: string|null, readerId: string, limit?: number }} p
 * @returns {Promise<object[]>} StudentAnnouncement[]
 */
async function listStudentStream({ studentId, school, schoolYearId, classId = null, readerId, limit = 30 }) {
  const { rows } = await db.query(q.listStudentAnnouncements, [studentId, school, schoolYearId, classId, readerId, limit]);
  if (!rows.length) return [];
  const [{ rows: files }, photos] = await Promise.all([
    db.query(q.selectAttachmentsForAnnouncements, [rows.map((r) => r.announcement_id)]),
    authorPhotoUrls(rows),
  ]);
  const byAnnouncement = new Map();
  for (const f of files) {
    const list = byAnnouncement.get(f.announcement_id) ?? [];
    list.push({ attachmentId: f.attachment_id, fileName: f.file_name, mimeType: f.mime_type, sizeBytes: f.size_bytes });
    byAnnouncement.set(f.announcement_id, list);
  }
  return rows.map((r) => toStudentAnnouncement(r, byAnnouncement.get(r.announcement_id) ?? [], photos.get(r.author_id)));
}

/**
 * May this student open this announcement? Same rule as the feed.
 * @returns {Promise<null | { status: number, body: object }>} null when allowed;
 *   404 for an unknown id, another school or a post outside the student's
 *   audience (existence is never revealed), 410 for a removed post.
 */
async function studentAnnouncementRefusal({ announcementId, studentId, schoolYearId, school }) {
  const { rows } = await db.query(q.selectStudentAnnouncementAccess, [announcementId, studentId, schoolYearId]);
  const row = rows[0];
  if (!row || row.school !== school || !row.in_audience) return { status: 404, body: NOT_FOUND };
  if (row.deleted_at) return { status: 410, body: REMOVED };
  return null;
}

module.exports = { toStudentAnnouncement, listStudentStream, studentAnnouncementRefusal };
