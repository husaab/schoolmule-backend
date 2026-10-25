// services/push/categories.js
//
// The kinds of push notification a person can switch off, and who each one
// is for. The app's Settings card lists the categories for the caller's
// roles (every view they hold) from this list. Each is also an Android
// notification channel, which the app creates (src/platform/push.ts), so a
// new category needs an app release for its channel.

const CATEGORIES = Object.freeze([
  { key: 'messages', label: 'Messages', description: 'New messages in your conversations.', roles: ['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'] },
  { key: 'announcements', label: 'Announcements', description: 'Posts from your school and classes.', roles: ['PARENT', 'STUDENT'] },
  { key: 'grades', label: 'Grades', description: 'When new grades are posted.', roles: ['PARENT', 'STUDENT'] },
  { key: 'classwork', label: 'Classwork', description: 'New work, and work due tomorrow.', roles: ['STUDENT'] },
  { key: 'reminders', label: 'Reminders', description: 'Messages waiting for your reply, and missing work.', roles: ['ADMIN', 'TEACHER', 'PARENT'] },
]);

// Any other staff role (an office account, a custom role) is treated as a teacher's.
const asKnownRole = (role) => (['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'].includes(role) ? role : 'TEACHER');

/** The categories for someone holding these roles. */
const categoriesFor = (roles = []) => {
  const held = new Set(roles.map(asKnownRole));
  return CATEGORIES.filter((c) => c.roles.some((r) => held.has(r)));
};

module.exports = { CATEGORIES, categoriesFor };
