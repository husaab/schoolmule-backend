// services/reportEngine/data/skills.js
//
// JK domains → skills and SK subjects → standards for one document type,
// with ratings and the group comment. Mirrors the JK/SK generators
// (controllers/jk.controller.js:521 / :613, controllers/sk.controller.js:463 / :566).
//
//   rating   the rating saved under the report's own term
//   t1 / t2  the ratings saved under the literal 'Term 1' / 'Term 2' — the
//            names the legacy report cards read (jk.controller.js:656/:662)
//   comment  JK domain comment / SK subject comment for the report's term
//
// Order is the legacy SQL order: group sort_order, then item sort_order.

const jkQueries = require('../../../queries/jk.queries');
const skQueries = require('../../../queries/sk.queries');
const { gradeText, text } = require('./format');

const LEGACY_T1 = 'Term 1';
const LEGACY_T2 = 'Term 2';

// The two kindergarten schemas differ only in names; one description each.
const KINDS = {
  JK: {
    groupsSql: jkQueries.getSkillDomainsByDocumentType,
    ratingsSql: jkQueries.getSkillAssessmentsForStudent,
    commentsSql: jkQueries.getDomainCommentsForStudent,
    groupId: 'domain_id',
    groupName: 'domain_name',
    itemId: 'skill_id',
    itemName: 'skill_name',
    itemDescription: 'skill_description',
    ratingItemId: 'skill_id',
    commentGroupId: 'domain_id',
  },
  SK: {
    groupsSql: skQueries.getSubjectsByDocumentType,
    ratingsSql: skQueries.getStandardAssessmentsForStudent,
    commentsSql: skQueries.getSubjectCommentsForStudent,
    groupId: 'subject_id',
    groupName: 'subject_name',
    itemId: 'standard_id',
    itemName: 'standard_name',
    itemDescription: 'standard_description',
    ratingItemId: 'standard_id',
    commentGroupId: 'subject_id',
  },
};

/**
 * Flat group+item rows → SkillGroup skeletons (nestDomainsAndSkills,
 * jk.controller.js:16 / nestSubjectsAndStandards, sk.controller.js:16).
 * A group with no items keeps an empty list.
 */
function nestGroups(rows, kind) {
  const k = KINDS[kind];
  const groups = new Map();
  for (const row of rows) {
    const gid = row[k.groupId];
    if (!groups.has(gid)) {
      groups.set(gid, { id: gid, name: text(row[k.groupName]), comment: '', items: [] });
    }
    if (row[k.itemId]) {
      groups.get(gid).items.push({
        id: row[k.itemId],
        name: text(row[k.itemName]),
        description: text(row[k.itemDescription]),
        rating: '',
        t1: '',
        t2: '',
      });
    }
  }
  return Array.from(groups.values());
}

/**
 * SkillGroup[] for a JK or SK student; [] for every other grade.
 * @param {'report_card'|'progress_report'} docType
 */
async function buildSkills(client, student, docType, term) {
  const kind = gradeText(student.grade);
  const k = KINDS[kind];
  if (!k) return [];

  const { rows: groupRows } = await client.query(k.groupsSql, [docType, student.school]);
  const groups = nestGroups(groupRows, kind);

  // One read per distinct term name ('Term 1' as the report term is read once).
  const ratingsByTerm = new Map();
  const ratingsFor = async (termName) => {
    if (!ratingsByTerm.has(termName)) {
      const { rows } = await client.query(k.ratingsSql, [student.student_id, termName, docType]);
      const map = {};
      for (const row of rows) map[row[k.ratingItemId]] = row.rating;
      ratingsByTerm.set(termName, map);
    }
    return ratingsByTerm.get(termName);
  };
  const current = await ratingsFor(term);
  const t1 = await ratingsFor(LEGACY_T1);
  const t2 = await ratingsFor(LEGACY_T2);

  const { rows: commentRows } = await client.query(k.commentsSql, [student.student_id, term]);
  const comments = {};
  for (const row of commentRows) comments[row[k.commentGroupId]] = row.comment;

  for (const group of groups) {
    group.comment = text(comments[group.id] || '');
    for (const item of group.items) {
      item.rating = text(current[item.id] || '');
      item.t1 = text(t1[item.id] || '');
      item.t2 = text(t2[item.id] || '');
    }
  }
  return groups;
}

module.exports = { buildSkills, nestGroups, LEGACY_T1, LEGACY_T2 };
