// services/classroom/childClassroom.js
//
// One read model for a child's classes, written once and called twice: by the
// student portal (studentId = the caller's own row, reader = the student) and
// by the parent's read-only lens (studentId = a child the parent owns, reader
// = the parent). The reader only decides read and "Got it" state; what a
// child's classes, Stream and teachers are never depends on who is looking.
// Archived classes never appear.

const db = require('../../config/database');
const q = require('../../queries/childClassroom.queries');
const { selectCurrentTerm } = require('../../queries/termScope');
const { identityOf } = require('./classView');
const { listStudentStream } = require('./studentStream');
const { signedPhotoUrl } = require('../profile/photos');

const firstNameOf = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/**
 * A child's student row, or null when it is unknown, archived or in another school.
 * @returns {Promise<null | { studentId, name, firstName, grade, schoolYearId, avatar, homeroomTeacherName }>}
 */
async function loadChild(studentId, school) {
  const { rows } = await db.query(q.selectChildProfile, [studentId]);
  const r = rows[0];
  if (!r || r.school !== school || r.is_archived) return null;
  return {
    studentId: r.student_id,
    name: r.name,
    firstName: firstNameOf(r.name),
    grade: r.grade,
    schoolYearId: r.school_year_id ?? null,
    avatar: r.avatar ?? null,
    homeroomTeacherName: r.homeroom_teacher_name ?? null,
  };
}

/** The school's active term within the year, or null (then no class is filtered out by term). */
async function currentTerm(school, schoolYearId) {
  const { rows } = await db.query(selectCurrentTerm, [school, schoolYearId ?? null]);
  return rows[0] || null;
}

const toTeacherLite = (t) => ({ userId: t.userId, name: t.name, avatar: t.avatar ?? null, role: t.role });

/** selectChildClasses row → StudentClassCard. */
function toStudentClassCard(row) {
  const teachers = (row.teachers || []).map(toTeacherLite);
  return {
    classId: row.class_id,
    subject: row.subject,
    grade: row.grade,
    termName: row.term_name ?? null,
    identity: identityOf(row),
    teacher: teachers.find((t) => t.role === 'lead') || null,
    teachers,
    next: null, // T15: the class's next item for this student
    missingCount: 0, // T15
    hasNewPost: Boolean(row.has_new_post),
  };
}

/**
 * The child's current-term classes of the year (never archived ones), by subject.
 * @param {{ studentId: string, school: string, schoolYearId: string|null, readerId: string }} p
 * @returns {Promise<object[]>} StudentClassCard[]
 */
async function listChildClasses({ studentId, school, schoolYearId, readerId }) {
  const term = await currentTerm(school, schoolYearId);
  const { rows } = await db.query(q.selectChildClasses, [
    studentId, school, schoolYearId ?? null, term?.term_id ?? null, term?.name ?? null, readerId,
  ]);
  return rows.map(toStudentClassCard);
}

/** The class's teachers (lead first) with signed photo URLs; empty unless the child is on the roster. */
async function loadClassTeachers(classId, studentId) {
  const { rows } = await db.query(q.selectChildClassTeachers, [classId, studentId]);
  return Promise.all(rows.map(async (r) => ({
    userId: r.user_id,
    name: r.name,
    avatar: r.avatar ?? null,
    photoUrl: await signedPhotoUrl(r.photo_path),
    role: r.role,
  })));
}

/**
 * The class header, or null when the child is not on the class's roster, the
 * class is archived, or it belongs to another school or year (404 NOT_ENROLLED).
 * @returns {Promise<object|null>} StudentClassHeader
 */
async function getChildClass({ studentId, classId, school, schoolYearId }) {
  const { rows } = await db.query(q.selectChildClass, [studentId, classId, school, schoolYearId ?? null]);
  const row = rows[0];
  if (!row) return null;
  const teachers = await loadClassTeachers(classId, studentId);
  const lead = teachers.find((t) => t.role === 'lead');
  return {
    classId: row.class_id,
    subject: row.subject,
    grade: row.grade,
    termName: row.term_name ?? null,
    identity: identityOf(row),
    teachers,
    messageTeacher: lead ? { userId: lead.userId, name: lead.name, avatar: lead.avatar, photoUrl: lead.photoUrl } : null,
  };
}

/**
 * The class Stream: the class's posts in the child's audience, with the
 * reader's own read and "Got it" state. Callers check getChildClass first.
 * @returns {Promise<{ announcements: object[], notices: object[] }>}
 */
async function getChildStream({ studentId, classId, school, schoolYearId, readerId, limit }) {
  const announcements = await listStudentStream({ studentId, school, schoolYearId, classId, readerId, limit });
  return { announcements, notices: [] }; // notices: T15
}

/** People for a child: the teachers only, never classmates. Callers check getChildClass first. */
async function getChildPeople({ studentId, classId }) {
  return { teachers: await loadClassTeachers(classId, studentId) };
}

/** The parent's children for the year (selectParentChildren rows), youngest grade first. */
async function listParentChildren({ parentId, school, schoolYearId }) {
  const { rows } = await db.query(q.selectParentChildren, [parentId, school, schoolYearId ?? null]);
  return rows;
}

/** "Needs you" acknowledgement items for the parent (NeedsYouItem kind 'ack'). */
async function listAckNeeded({ parentId, school, schoolYearId }) {
  const { rows } = await db.query(q.selectAckNeeded, [parentId, school, schoolYearId ?? null]);
  return rows.map((r) => ({
    kind: 'ack',
    announcementId: r.announcement_id,
    title: r.title,
    classSubject: r.class_subject ?? null,
    authorName: r.author_name || 'SchoolMule',
    publishedAt: new Date(r.published_at).toISOString(),
    studentIds: r.student_ids || [],
  }));
}

module.exports = {
  loadChild,
  listChildClasses,
  getChildClass,
  getChildStream,
  getChildPeople,
  listParentChildren,
  listAckNeeded,
  toStudentClassCard,
};
