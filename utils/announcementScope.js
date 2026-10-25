// utils/announcementScope.js
//
// Human labels and portal links for an announcement's audience, shared by
// the controller (list items) and the notifier (email subject/body).

/** "Gr 6 Math" | "Grade 6" | "Whole school" | "Selected families" from a row with scope, grade, class_subject, class_grade. */
const scopeLabel = ({ scope, grade, class_subject: subject, class_grade: classGrade }) => {
  if (scope === 'class') return [classGrade ? `Gr ${classGrade}` : null, subject].filter(Boolean).join(' ') || 'Class';
  if (scope === 'grade') return `Grade ${grade}`;
  if (scope === 'custom') return 'Selected families';
  return 'Whole school';
};

/** Where a guardian lands (email or push): the Announcements tab with the post opened. */
const parentPath = (announcementId) => `/parent/messages?tab=announcements&announcement=${announcementId}`;
const parentLink = (announcementId) => `${process.env.FRONTEND_URL || ''}${parentPath(announcementId)}`;

/**
 * Where a student lands (email or push): the class Stream with the post
 * opened for a post that belongs to a class (a class post, or chosen students
 * picked in a class Stream: a custom post with its class, M4), otherwise the
 * student home. `ctx` has announcement_id and class_id.
 */
const studentPath = ({ announcement_id: id, class_id: classId }) =>
  (classId ? `/student/classes/${classId}?announcement=${id}` : `/student?announcement=${id}`);
const studentLink = (ctx) => `${process.env.FRONTEND_URL || ''}${studentPath(ctx)}`;

module.exports = { scopeLabel, parentPath, parentLink, studentPath, studentLink };
