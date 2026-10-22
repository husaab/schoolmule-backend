// queries/personName.js
//
// A person's display name from their users row: the salutation
// (users.honorific: Mr. | Ms. | Mrs. | Dr.; not the role label in
// users.staff_title), when they have one, before the full name ("Ms. Doha
// Chahade"), else the plain name. Only staff carry one, so the same
// expression serves any row (a parent who sent a message shows by name). `u` is the users
// alias. '' for a row with no name, as TRIM(CONCAT(first, ' ', last)) was,
// so callers keep their NULLIF / COALESCE fallbacks.
const PERSON_NAME = (u) =>
  `TRIM(CONCAT_WS(' ', ${u}.honorific, NULLIF(TRIM(${u}.first_name), ''), NULLIF(TRIM(${u}.last_name), '')))`;

// A class's lead teacher as parents see them, for a query that LEFT JOINs the
// teacher's users row as `t` (ON t.user_id = c.teacher_id): the account's
// name with its salutation, else the name stored on the class, which is copied at
// save time and can be stale.
const CLASS_TEACHER_NAME = (c, t) => `COALESCE(NULLIF(${PERSON_NAME(t)}, ''), ${c}.teacher_name)`;

module.exports = { PERSON_NAME, CLASS_TEACHER_NAME };
