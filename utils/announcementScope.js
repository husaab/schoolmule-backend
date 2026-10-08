// utils/announcementScope.js
//
// Human labels and portal links for an announcement's audience, shared by
// the controller (list items) and the notifier (email subject/body).

/** "Gr 6 Math" | "Grade 6" | "Whole school" from a row with scope, grade, class_subject, class_grade. */
const scopeLabel = ({ scope, grade, class_subject: subject, class_grade: classGrade }) => {
  if (scope === 'class') return [classGrade ? `Gr ${classGrade}` : null, subject].filter(Boolean).join(' ') || 'Class';
  if (scope === 'grade') return `Grade ${grade}`;
  return 'Whole school';
};

/** Where a guardian lands from an email: the Announcements tab with the post opened. */
const parentLink = (announcementId) =>
  `${process.env.FRONTEND_URL || ''}/parent/messages?tab=announcements&announcement=${announcementId}`;

module.exports = { scopeLabel, parentLink };
