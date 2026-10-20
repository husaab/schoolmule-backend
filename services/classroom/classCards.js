// services/classroom/classCards.js
//
// How the teacher's classroom reads are shown: ClassCard, ComingUpRow, the
// teacher list and the People roster. Pure shaping of query rows, so the
// controller stays small and every payload agrees.

const { identityOf, optionsOf } = require('./classView');
const { deriveStatus, isQrEligible, latestInvite, signInMethodOf } = require('./studentAccounts');

const iso = (value) => (value ? new Date(value).toISOString() : null);

const UNNAMED_PARENT = 'Parent';
const KINDERGARTEN_RE = /kindergarten|^[js]k\b/i;

/** "Grade 5 Science"; a JK or SK class reads "JK Science" (and just its own name when that already says so). */
function classLabel(grade, subject) {
  const g = String(grade ?? '');
  const name = String(subject ?? '').trim();
  if (g === 'JK' || g === 'SK') return KINDERGARTEN_RE.test(name) ? name : `${g} ${name}`.trim();
  return `Grade ${g} ${name}`.trim();
}

/** selectClassCards / selectClassCard row → ClassCard. `photos` maps a teacher's photo path to its signed URL. */
function toClassCard(row, photos = new Map()) {
  return {
    classId: row.class_id,
    subject: row.subject,
    grade: row.grade,
    termId: row.term_id ?? null,
    termName: row.term_name ?? null,
    teacherId: row.teacher_id ?? null,
    teacherName: row.teacher_name ?? null,
    teachers: (row.teachers || []).map((t) => ({
      userId: t.userId, name: t.name, role: t.role, avatar: t.avatar ?? null, photoUrl: photos.get(t.photoPath) ?? null,
    })),
    studentCount: Number(row.student_count) || 0,
    identity: identityOf(row),
    archivedAt: iso(row.archived_at),
    toReviewCount: Number(row.to_review_count) || 0,
    next: row.next ?? null,
  };
}

/** The photo paths of the teachers on these card rows, to sign in one go. */
const cardPhotoPaths = (rows) => rows.flatMap((r) => (r.teachers || []).map((t) => t.photoPath));

/** The header's card: the ClassCard plus the class options. */
const toHeaderClass = (row, photos) => ({ ...toClassCard(row, photos), options: optionsOf(row) });

/**
 * Done in class, nothing turned in online: a plain assessment, or an
 * assignment whose turn-in is "Nothing to turn in". Quizzes are taken online.
 */
const isInClass = (kind, submissionMode) => kind === 'assessment' || (kind === 'assignment' && submissionMode === 'none');

/** COMING_UP row → ComingUpRow. Still to turn in = the students the item reaches, less those who turned it in. */
function toComingUpRow(row) {
  const kind = row.kind ?? 'assessment';
  const inClass = isInClass(kind, row.submission_mode);
  return {
    itemId: row.item_id ?? null,
    assessmentId: row.assessment_id ?? null,
    classId: row.class_id,
    classLabel: classLabel(row.grade, row.subject),
    title: row.title,
    kind,
    date: row.date,
    dueAt: iso(row.due_at),
    inClass,
    stillToTurnIn: inClass ? null : Math.max(0, (Number(row.audience_size) || 0) - (Number(row.turned_in_count) || 0)),
  };
}

/** TO_REVIEW row → a "To review" entry: an item with turned-in work waiting for a grade. */
const toReviewRow = (row) => ({
  itemId: row.item_id,
  classId: row.class_id,
  classLabel: classLabel(row.grade, row.subject),
  iconUrl: identityOf(row).iconUrl,
  title: row.title,
  turnedInCount: Number(row.turned_in_count) || 0,
});

/** DRAFTS_AND_SCHEDULED row → a "Drafts & scheduled" entry. */
const toDraftRow = (row) => ({
  itemId: row.item_id,
  classId: row.class_id,
  classLabel: classLabel(row.grade, row.subject),
  title: row.title,
  kind: row.kind,
  status: row.status,
  publishAt: iso(row.publish_at),
});

/** STREAM_NOTICES row → a teacher Stream classwork notice. */
const toNotice = (row) => ({
  itemId: row.item_id,
  kind: row.kind,
  title: row.title,
  postedAt: iso(row.posted_at),
  dueAt: iso(row.due_at),
  turnedInCount: Number(row.turned_in_count) || 0,
  total: Number(row.total) || 0,
});

/** selectClassTeachers row → header/People teacher. `photoUrl` is the signed URL, signed by the caller. */
const toTeacher = (row, photoUrl) => ({
  userId: row.user_id,
  name: row.name,
  role: row.role,
  avatar: row.avatar ?? null,
  photoUrl: photoUrl ?? null,
  homeroomGrade: row.homeroom_grade ?? null,
});

/**
 * One entry per parent address (case-insensitive). Rows arrive account-holders
 * first, so the copy with a login is the one kept. A parent with no name on
 * file shows as "Parent" (the address itself never leaves the server); a row
 * with no address dedupes on its name; one with neither is dropped.
 */
function dedupeParents(parents) {
  const seen = new Set();
  const out = [];
  for (const p of parents || []) {
    if (!p.name && !p.emailKey) continue;
    const name = p.name || UNNAMED_PARENT;
    const key = p.emailKey || `name:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, relation: p.relation ?? null, hasAccount: Boolean(p.hasAccount) });
  }
  return out;
}

/**
 * selectPeopleStudents row → a People student. `settings` are the school's
 * classroom settings; `photos` maps a login's photo path to its signed URL
 * (signed only while the school has student photos on).
 */
function toPeopleStudent(row, settings, photos = new Map()) {
  const status = deriveStatus(row, settings);
  return {
    studentId: row.student_id,
    name: row.name,
    avatar: row.avatar ?? null,
    photoUrl: (settings.studentPhotos && photos.get(row.photo_path)) || null,
    account: {
      status,
      userId: row.user_id ?? null,
      lastSeenAt: iso(row.last_seen_at),
      qrEligible: isQrEligible(status, row.grade, settings),
      // The login's latest invite and how it signs in, as on Student accounts.
      invite: row.user_id ? latestInvite(row) : null,
      signInMethod: signInMethodOf(row),
    },
    parents: dedupeParents(row.parents),
    missingCount: Number(row.missing_count) || 0,
  };
}

/** Header counts of the People roster. */
const peopleCounts = (students) => ({
  students: students.length,
  notSignedIn: students.filter((s) => s.account.status === 'not_invited' || s.account.status === 'invited').length,
  missingWork: students.filter((s) => s.missingCount > 0).length,
});

module.exports = {
  classLabel, isInClass, toClassCard, cardPhotoPaths, toHeaderClass, toComingUpRow, toReviewRow, toDraftRow, toNotice, toTeacher, dedupeParents, toPeopleStudent, peopleCounts,
};
