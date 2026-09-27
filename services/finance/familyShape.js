// services/finance/familyShape.js
//
// The family model as the API speaks it. One loader for the per-year rows
// (families, their students, contacts and customer links) and one set of
// mappers, so the grid, the family list, the detail view and the suggestion
// engine all shape the same data the same way.

const queries = require('../../queries/finance.queries');
const { buildLinkIndex } = require('./gridAssembly');
const { groupBy } = require('./util');

const toStudent = (s) => ({ studentId: s.student_id, name: s.name, grade: s.grade, isArchived: Boolean(s.is_archived), ...(s.added_at ? { addedAt: s.added_at } : {}) });
const toContact = (c) => ({ contactId: c.contact_id, name: c.name, email: c.email, phone: c.phone, relation: c.relation, isPrimary: Boolean(c.is_primary), hasAccount: Boolean(c.user_id), source: c.source });

/**
 * The year's families with their students, contacts and links, grouped and indexed.
 * @param {object} db  pool or client with .query
 */
async function loadFamilyYear(db, school, yearId) {
  const [families, students, contacts, links] = await Promise.all([
    db.query(queries.selectFamiliesByYear, [school, yearId]),
    db.query(queries.selectFamilyStudentsByYear, [school, yearId]),
    db.query(queries.selectFamilyContactsByYear, [school, yearId]),
    db.query(queries.selectFamilyLinksByYear, [school, yearId]),
  ].map((p) => p.then((r) => r.rows)));
  return {
    families, students, contacts, links,
    studentsBy: groupBy(students, 'family_id'),
    contactsBy: groupBy(contacts, 'family_id'),
    linkIndex: buildLinkIndex(links),
  };
}

module.exports = { loadFamilyYear, toStudent, toContact };
