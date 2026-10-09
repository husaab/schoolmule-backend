// utils/parentPortalView.js
// Shaping helpers for parent-portal payloads that depend on who is looking.

/**
 * Flag each class the viewer teaches. A staff member in their parent view
 * sees their own child's class here; the portal hides "Ask the teacher" on
 * it because the teacher would be writing to themself.
 * @param {Array<{classId: string}>} classes  breakdown classes (not mutated)
 * @param {string[]} taughtClassIds           class ids the viewer leads or co-teaches
 */
const markTaughtByViewer = (classes, taughtClassIds) => {
  const taught = new Set(taughtClassIds);
  return classes.map((cls) => ({ ...cls, taughtByViewer: taught.has(cls.classId) }));
};

module.exports = { markTaughtByViewer };
