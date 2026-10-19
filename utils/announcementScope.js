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

/** Where a guardian lands from an email: the Announcements tab with the post opened. */
const parentLink = (announcementId) =>
  `${process.env.FRONTEND_URL || ''}/parent/messages?tab=announcements&announcement=${announcementId}`;

/**
 * Where a student lands from an email: the class Stream with the post opened
 * for a post that belongs to a class (a class post, or chosen students picked
 * in a class Stream: a custom post with its class, M4), otherwise the student
 * home. `ctx` has announcement_id and class_id.
 */
const studentLink = ({ announcement_id: id, class_id: classId }) => {
  const base = process.env.FRONTEND_URL || '';
  return classId
    ? `${base}/student/classes/${classId}?announcement=${id}`
    : `${base}/student?announcement=${id}`;
};

module.exports = { scopeLabel, parentLink, studentLink };
