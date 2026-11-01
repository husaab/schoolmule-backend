// services/reportEngine/data/learningSkills.js
//
// The JK report card's six Learning Skills (E/G/S/N), in the legacy order
// with the legacy descriptors. The names and descriptors are copied from
// templates/alHaadiReportCardJKTemplate.js:9-52 (not exported there); the
// parity test checks the legacy card prints the same text.
//
//   rating   jk_learning_skills under the report's term (what the legacy
//            card prints, jk.controller.js:677)
//   t1 / t2  the same under the literal 'Term 1' / 'Term 2'
//
// [] for every other grade and for progress reports.

const jkQueries = require('../../../queries/jk.queries');
const { gradeText, text } = require('./format');
const { LEGACY_T1, LEGACY_T2 } = require('./skills');

const LEARNING_SKILL_NAMES = [
  'Responsibility',
  'Organization',
  'Independent Work',
  'Initiative',
  'Collaboration',
  'Self-Regulation',
];

const LEARNING_SKILL_DESCRIPTORS = {
  'Responsibility': [
    'Fulfils responsibilities and commitments within the learning environment',
    'Completes and submits class work, homework, and assignments according to agreed-upon timelines.',
  ],
  'Organization': [
    'Devises and follows a plan and process for completing work and tasks.',
    'Establishes priorities and manages time to complete tasks and achieve goals.',
  ],
  'Independent Work': [
    'Independently monitors, assesses, and revises plans to complete tasks and meet goals.',
    'Uses class time appropriately to complete tasks.',
  ],
  'Initiative': [
    'Looks for and acts on new ideas and opportunities for learning.',
    'Demonstrates the capacity for innovation and a willingness to take risks.',
    'Demonstrates curiosity and interest in learning.',
    'Approaches new tasks with a positive attitude.',
    'Recognizes and advocates appropriately for the rights of self and others.',
  ],
  'Collaboration': [
    'Accepts various roles and an equitable share of work in a group.',
    'Responds positively to the ideas, opinions, values, and traditions of others.',
    'Builds healthy peer-to-peer relationships through personal and media-assisted interactions.',
    'Works with others to resolve conflicts and build consensus to achieve group goals.',
    'Shares information, resources, and expertise, and promotes critical thinking to solve problems and make decisions.',
  ],
  'Self-Regulation': [
    'Sets own individual goals and monitors progress towards achieving them.',
    'Seeks clarification or assistance when needed.',
    'Assesses and reflects critically on own strengths, needs, and interests.',
    'Identifies learning opportunities, choices, and strategies to meet personal needs and achieve goals.',
    'Perseveres and makes an effort when responding to challenges',
  ],
};

async function buildLearningSkills(client, student, docType, term) {
  if (docType !== 'report_card' || gradeText(student.grade) !== 'JK') return [];

  const byTerm = new Map();
  const ratingsFor = async (termName) => {
    if (!byTerm.has(termName)) {
      const { rows } = await client.query(jkQueries.getLearningSkillsForStudent, [student.student_id, termName]);
      const map = {};
      for (const row of rows) map[row.skill_name] = row.rating;
      byTerm.set(termName, map);
    }
    return byTerm.get(termName);
  };
  const current = await ratingsFor(term);
  const t1 = await ratingsFor(LEGACY_T1);
  const t2 = await ratingsFor(LEGACY_T2);

  return LEARNING_SKILL_NAMES.map((name) => ({
    name,
    descriptors: [...(LEARNING_SKILL_DESCRIPTORS[name] || [])],
    rating: text(current[name] || ''),
    t1: text(t1[name] || ''),
    t2: text(t2[name] || ''),
  }));
}

module.exports = { buildLearningSkills, LEARNING_SKILL_NAMES, LEARNING_SKILL_DESCRIPTORS };
