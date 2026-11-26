// services/assistant/tools/staff/classes.js
//
// Read tools about classes: the list, a roster, a day's attendance and the
// gradebook. Each builds its answer from an allowlist of fields: a name and
// a ref, never an id, an education number or a contact detail (the roster
// route returns all of those; none of them is copied out here).

const { defineTool } = require('../registry');
const { ToolError } = require('../../errors');

const STAFF = ['ADMIN', 'TEACHER'];
const REF = { type: 'string', description: 'A ref from an earlier tool result, such as "c1".' };

const classLabel = (c) => `${c.subject} · Grade ${c.grade}`;
const STATUS_LABEL = { PRESENT: 'Present', ABSENT: 'Absent', LATE: 'Late', EXCUSED: 'Excused' };
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day from what the model sent: 'today', or YYYY-MM-DD that is a real date. */
function dayFrom(value, today) {
  if (value === 'today') return today;
  if (!ISO_DAY.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))) {
    throw new ToolError('INVALID_ARGUMENTS', 'date must be "today" or a day written YYYY-MM-DD.');
  }
  return value;
}

/** The class's students as { ref, name } in name order, minting a ref for each. */
async function rosterOf(ctx, classId) {
  const { data } = await ctx.read('classStudents', { params: { classId } });
  return (data || [])
    .map((s) => ({ id: s.studentId, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => ({ id: s.id, ref: ctx.refs.mint('student', s.id, s.name), name: s.name }));
}

defineTool({
  name: 'list_classes',
  doing: 'Looking up classes',
  description:
    'List the classes this person can open, each with a ref to use in other tools. "mine" is true for the classes they teach. Use it when the person names a class you have no ref for yet.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  views: STAFF,
  handler: async (_args, ctx) => {
    const { data } = await ctx.read('classes');
    const open = (data || []).filter((c) => !c.archivedAt);
    const classes = open.map((c) => ({
      ref: ctx.refs.mint('class', c.classId, classLabel(c)),
      name: classLabel(c),
      subject: c.subject,
      grade: String(c.grade),
      teacher: c.teacherName,
      term: c.termName,
      mine: c.teacherId === ctx.user.userId || (c.additionalTeachers || []).some((t) => t.teacherId === ctx.user.userId),
    }));
    // The person's own classes first, so a long school-wide list still leads with them.
    classes.sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name));
    const shown = classes.slice(0, 80);
    return {
      summary: `${classes.length} ${classes.length === 1 ? 'class' : 'classes'}`,
      forModel: { classes: shown, more: classes.length - shown.length },
    };
  },
});

defineTool({
  name: 'get_class_roster',
  doing: 'Reading the class list',
  description: 'List the students in one class, each with a ref. Use it before anything that names a student.',
  parameters: { type: 'object', properties: { class: REF }, required: ['class'], additionalProperties: false },
  views: STAFF,
  handler: async (args, ctx) => {
    const cls = ctx.refs.resolve(args.class, 'class');
    const students = await rosterOf(ctx, cls.id);
    return {
      summary: `${students.length} ${students.length === 1 ? 'student' : 'students'} in ${cls.label}`,
      forModel: { class: cls.label, students: students.map(({ ref, name }) => ({ ref, name })) },
    };
  },
});

defineTool({
  name: 'get_class_attendance',
  doing: 'Reading attendance',
  description:
    'The attendance marks of one class on one day: each student and Present, Late, Absent, Excused or unmarked. date is "today" or YYYY-MM-DD.',
  parameters: {
    type: 'object',
    properties: { class: REF, date: { type: 'string', description: '"today" or a day written YYYY-MM-DD.' } },
    required: ['class', 'date'],
    additionalProperties: false,
  },
  views: STAFF,
  handler: async (args, ctx) => {
    const cls = ctx.refs.resolve(args.class, 'class');
    const date = dayFrom(args.date, ctx.today);
    const [students, marks] = await Promise.all([
      rosterOf(ctx, cls.id),
      ctx.read('classAttendance', { params: { classId: cls.id }, query: { date } }),
    ]);
    const statusOf = new Map((marks.data || []).map((m) => [m.studentId, m.status]));
    const rows = students.map((s) => ({ ref: s.ref, name: s.name, status: STATUS_LABEL[statusOf.get(s.id)] || 'unmarked' }));
    const counts = rows.reduce((all, r) => ({ ...all, [r.status]: (all[r.status] || 0) + 1 }), {});
    const marked = rows.length - (counts.unmarked || 0);
    return {
      summary: marked === 0 ? `${cls.label} has no attendance for ${date}` : `${marked} of ${rows.length} marked for ${date}`,
      forModel: { class: cls.label, date, counts, students: rows },
      card: {
        type: 'table',
        title: `Attendance · ${cls.label}`,
        subtitle: date,
        tier: 'read',
        columns: [{ key: 'name', label: 'Student' }, { key: 'status', label: 'Status', align: 'right' }],
        rows: rows.map(({ name, status }) => ({ name, status })),
      },
    };
  },
});

defineTool({
  name: 'get_gradebook',
  doing: 'Reading the gradebook',
  description:
    'The marks of one class: its assessments (each with a ref and what it is out of) and each student\'s mark in each. A mark is a number, "missing" (counts as zero), "excused" (never counts) or null (not graded yet, carries no weight). Pass assessment to get one column only, which is right for a large class.',
  parameters: {
    type: 'object',
    properties: { class: REF, assessment: { type: ['string', 'null'], description: 'An assessment ref to return that column only, or null for every column.' } },
    required: ['class', 'assessment'],
    additionalProperties: false,
  },
  views: STAFF,
  handler: async (args, ctx) => {
    const cls = ctx.refs.resolve(args.class, 'class');
    const only = args.assessment ? ctx.refs.resolve(args.assessment, 'assessment').id : null;
    const { data } = await ctx.read('classScores', { params: { classId: cls.id } });
    const rows = data || [];

    const assessments = new Map();
    const students = new Map();
    for (const r of rows) {
      if (!assessments.has(r.assessment_id)) {
        assessments.set(r.assessment_id, {
          id: r.assessment_id,
          ref: ctx.refs.mint('assessment', r.assessment_id, r.assessment_name),
          name: r.assessment_name,
          outOf: r.max_score === null || r.max_score === undefined ? 100 : Number(r.max_score),
          category: Boolean(r.is_parent), // a category groups other assessments and holds no marks of its own
        });
      }
      if (!students.has(r.student_id)) {
        students.set(r.student_id, { ref: ctx.refs.mint('student', r.student_id, r.student_name), name: r.student_name, marks: {} });
      }
      if (r.is_parent || (only && r.assessment_id !== only)) continue;
      const mark = r.status === 'missing' || r.status === 'excused' ? r.status : r.score === null || r.score === undefined ? null : Number(r.score);
      students.get(r.student_id).marks[assessments.get(r.assessment_id).ref] = mark;
    }

    const columns = [...assessments.values()].filter((a) => !only || a.id === only).map(({ ref, name, outOf, category }) => ({ ref, name, outOf, category }));
    const list = [...students.values()].sort((a, b) => a.name.localeCompare(b.name));
    return {
      summary: `${list.length} students, ${columns.filter((c) => !c.category).length} ${only ? 'assessment' : 'assessments'} in ${cls.label}`,
      forModel: { class: cls.label, assessments: columns, students: list },
    };
  },
});
