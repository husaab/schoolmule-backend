// services/progressSalaat.js
//
// The Salaat box on the grades 1-8 progress report (schools.progress_salaat):
// the homeroom teacher's Work Habits, Behaviour and comment for the term.
// Both report paths (the engine's data assembler and the legacy generator)
// print it after the subject cards; an entry nobody filled in prints as
// "Not Assessed", like a class with no feedback.

const q = require('../queries/progressSalaat.queries');

const SALAAT_SUBJECT = 'Salaat';

/**
 * The student's Salaat entry for the term, or null when the school doesn't
 * print Salaat. `client` is a pg pool or client.
 * @returns {Promise<null | { workHabit: string, behavior: string, comment: string }>}
 */
async function loadSalaat(client, { studentId, school, term }) {
  const { rows: flag } = await client.query(q.selectSchoolSalaat, [String(school)]);
  if (flag[0]?.progress_salaat !== true) return null;
  const { rows } = await client.query(q.selectEntry, [studentId, term]);
  const row = rows[0];
  return {
    workHabit: row?.work_habit || '',
    behavior: row?.behavior || '',
    comment: row?.comment || '',
  };
}

/** The homeroom teacher's name for the box's bar: '' for the legacy 'N/A'. */
const salaatTeacher = (homeroomTeacher) => {
  const name = String(homeroomTeacher ?? '').trim();
  return name === 'N/A' ? '' : name;
};

module.exports = { loadSalaat, salaatTeacher, SALAAT_SUBJECT };
