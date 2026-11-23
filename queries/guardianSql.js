// queries/guardianSql.js
//
// SQL fragments for reading a student's guardians off the student file
// (mother_email / father_email), shared by messaging (who staff can reach,
// queries/messaging.queries.js) and the admin overview (students with no
// guardian, queries/adminOverview.queries.js), so the two can't disagree.

// Student files hold whatever was imported, so check it really is one address.
const IS_EMAIL = (e) => `TRIM(${e}) ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'`;

// The office took this address off this student: reading it from the file again
// would undo that.
const OFFICE_REMOVED = (s, e) => `EXISTS (SELECT 1 FROM guardian_removals gr WHERE gr.student_id = ${s}.student_id AND gr.email = LOWER(TRIM(${e})))`;

module.exports = { IS_EMAIL, OFFICE_REMOVED };
