// services/push/categories.js
//
// The kinds of push notification a person can switch off, and who each one
// is for. The app's Settings card shows the categories for the caller's
// roles (every view they hold), straight from this list, so a new category
// needs no app release. Each is also an Android notification channel.

const STAFF = ['ADMIN', 'TEACHER'];

const CATEGORIES = Object.freeze([
  { key: 'messages', label: 'Messages', description: 'New messages in your conversations.', roles: ['ADMIN', 'TEACHER', 'PARENT', 'STUDENT'] },
  { key: 'announcements', label: 'Announcements', description: 'Posts from your school and classes.', roles: ['PARENT', 'STUDENT'] },
  { key: 'grades', label: 'Grades', description: 'When new grades are posted.', roles: ['PARENT', 'STUDENT'] },
  { key: 'classwork', label: 'Classwork', description: 'New work, and work due tomorrow.', roles: ['STUDENT'] },
  { key: 'reminders', label: 'Reminders', description: 'Messages waiting for your reply, and missing work.', roles: [...STAFF, 'PARENT'] },
]);

const KEYS = new Set(CATEGORIES.map((c) => c.key));

/** Is this a category key? */
const isCategory = (key) => KEYS.has(key);

/** The categories for someone holding these roles (any staff role counts as staff). */
const categoriesFor = (roles = []) => {
  const held = new Set(roles.map((r) => (r === 'PARENT' || r === 'STUDENT' ? r : STAFF.includes(r) ? r : 'TEACHER')));
  return CATEGORIES.filter((c) => c.roles.some((r) => held.has(r)));
};

module.exports = { CATEGORIES, isCategory, categoriesFor };
