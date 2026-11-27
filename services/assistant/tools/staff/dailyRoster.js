// services/assistant/tools/staff/dailyRoster.js
//
// Who a day's general (daily) attendance is for: the person's homeroom (the
// students whose homeroom teacher they are), one grade, or the whole school.
// Read from the school's student list with the person's own token (the
// General Attendance page reads the same list).

const { ToolError } = require('../../errors');

const SCOPES = ['homeroom', 'grade', 'school'];

/** -> { students: [{ id, name, grade }] in grade then name order, label } */
async function dailyRoster(ctx, { scope, grade }) {
  if (!SCOPES.includes(scope)) throw new ToolError('INVALID_ARGUMENTS', 'who must be "homeroom", "grade" or "school".');
  if (scope === 'grade' && !grade) throw new ToolError('INVALID_ARGUMENTS', 'Name the grade, such as "6".');
  const { data } = await ctx.read('students');
  let students = (data || []).map((s) => ({ id: s.studentId, name: s.name, grade: s.grade == null ? null : String(s.grade), homeroom: s.homeroomTeacherId || null }));
  let label = 'Whole school';
  if (scope === 'homeroom') {
    students = students.filter((s) => s.homeroom === ctx.user.userId);
    label = 'Your homeroom';
    if (students.length === 0) throw new ToolError('NO_HOMEROOM', 'No students have this person as their homeroom teacher. Ask which grade to take attendance for, or whether they mean the whole school.');
  } else if (scope === 'grade') {
    students = students.filter((s) => s.grade === String(grade));
    label = `Grade ${grade}`;
    if (students.length === 0) throw new ToolError('NO_STUDENTS', `There are no students in Grade ${grade} this year.`);
  }
  const rank = (g) => (g === 'JK' ? -2 : g === 'SK' ? -1 : Number(g) || 99);
  students.sort((a, b) => rank(a.grade) - rank(b.grade) || a.name.localeCompare(b.name));
  return { students: students.map(({ id, name, grade: g }) => ({ id, name, grade: g })), label };
}

const WHO = {
  type: 'string',
  enum: SCOPES,
  description: '"homeroom": the students whose homeroom teacher this person is (what a teacher usually means by "my students"); "grade": one grade (give grade); "school": every student.',
};

module.exports = { dailyRoster, SCOPES, WHO };
