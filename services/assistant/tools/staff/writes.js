// services/assistant/tools/staff/writes.js
//
// Tools that prepare a change. They read the current values, work out what
// would change, and record it as a pending action (ctx.propose): the person
// sees a preview with an Apply button, and nothing is written until they
// press it (services/assistant/actions/service.js). Offered only where the
// school allows Muley to prepare changes (ai_assistant_settings.allow_writes).

const { defineTool } = require('../registry');
const { ToolError } = require('../../errors');
const { KINDS, STATUS_LABEL } = require('../../actions/kinds');

const STAFF = ['ADMIN', 'TEACHER'];
const REF = { type: 'string', description: 'A ref from an earlier tool result, such as "c1".' };
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ATTENDANCE = ['PRESENT', 'LATE', 'ABSENT'];
const MAX_ROWS_SHOWN = 60;

function dayFrom(value, today) {
  if (value === 'today') return today;
  if (!ISO_DAY.test(value) || Number.isNaN(Date.parse(`${value}T12:00:00Z`))) {
    throw new ToolError('INVALID_ARGUMENTS', 'date must be "today" or a day written YYYY-MM-DD.');
  }
  if (value > today) throw new ToolError('FUTURE_DATE', 'Attendance can only be taken for today or an earlier day.');
  return value;
}

const PREPARED_NOTE = 'The person now sees a preview of exactly this change with an Apply button. Nothing is saved until they press it. In one or two sentences, say what will change and that they can press Apply. Do not say it was saved.';

defineTool({
  name: 'propose_class_attendance',
  doing: 'Preparing attendance',
  writes: true,
  description:
    'Prepare class attendance for one class and day, for the person to apply. Name the students whose mark you know in `marks`; `everyone_else` marks every other student of the class (only those not marked yet, unless `overwrite` is true). Example: "everyone is here except Yusuf, Maryam was late" is marks [{student: Yusuf\'s ref, status: ABSENT}, {student: Maryam\'s ref, status: LATE}] with everyone_else PRESENT. Read the roster first so you have the students\' refs; if a name matches more than one student, ask the person to choose instead.',
  parameters: {
    type: 'object',
    properties: {
      class: REF,
      date: { type: 'string', description: '"today" or a day written YYYY-MM-DD (never a future day).' },
      marks: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          properties: { student: REF, status: { type: 'string', enum: ATTENDANCE } },
          required: ['student', 'status'],
          additionalProperties: false,
        },
      },
      everyone_else: { type: ['string', 'null'], enum: [...ATTENDANCE, null], description: 'The mark for every student not named in marks, or null to leave them.' },
      overwrite: { type: 'boolean', description: 'true to replace marks already saved for that day; false to fill in only students not marked yet.' },
    },
    required: ['class', 'date', 'marks', 'everyone_else', 'overwrite'],
    additionalProperties: false,
  },
  views: STAFF,
  handler: async (args, ctx) => {
    const cls = ctx.refs.resolve(args.class, 'class');
    const date = dayFrom(args.date, ctx.today);
    const [{ data: roster }, current] = await Promise.all([
      ctx.read('classStudents', { params: { classId: cls.id } }),
      KINDS.class_attendance.read(ctx.read, { classId: cls.id, date }),
    ]);
    const students = (roster || []).map((s) => ({ id: s.studentId, name: s.name })).sort((a, b) => a.name.localeCompare(b.name));
    const inClass = new Map(students.map((s) => [s.id, s]));

    const named = new Map();
    for (const mark of args.marks) {
      const student = ctx.refs.resolve(mark.student, 'student');
      if (!inClass.has(student.id)) throw new ToolError('NOT_IN_CLASS', `${student.label} is not in ${cls.label}.`);
      named.set(student.id, mark.status);
    }

    const targets = {};
    const before = {};
    for (const s of students) {
      const now = current[s.id] ?? null;
      let next = now;
      if (named.has(s.id)) next = named.get(s.id);
      else if (args.everyone_else && (args.overwrite || now === null)) next = args.everyone_else;
      if (next !== now) {
        targets[s.id] = next;
        before[s.id] = now;
      }
    }

    const changed = students.filter((s) => s.id in targets);
    if (changed.length === 0) {
      return { summary: 'Nothing to change', forModel: { prepared: false, note: `Every mark for ${cls.label} on ${date} is already as asked. Tell the person nothing needed changing.` } };
    }

    const after = students.map((s) => (s.id in targets ? targets[s.id] : current[s.id] ?? null));
    const tally = {};
    for (const status of after) {
      const label = STATUS_LABEL[status] || 'Unmarked';
      tally[label] = (tally[label] || 0) + 1;
    }
    const rows = changed.map((s) => ({ key: s.id, name: s.name, now: STATUS_LABEL[before[s.id]] || 'unmarked', next: STATUS_LABEL[targets[s.id]] }));
    const left = students.length - changed.length;
    const title = `Class attendance · ${cls.label} · ${date}`;
    const action = await ctx.propose({
      kind: 'class_attendance',
      title,
      args: { classId: cls.id, date, className: cls.label, targets },
      before,
      preview: { rows },
    });
    return {
      summary: `${changed.length} ${changed.length === 1 ? 'mark' : 'marks'} ready to save`,
      forModel: { prepared: true, class: cls.label, date, changes: rows.slice(0, 40).map(({ name, now, next }) => ({ name, now, next })), unchanged: left, note: PREPARED_NOTE },
      action,
      card: {
        type: 'change',
        actionId: action.id,
        title: `Class attendance · ${cls.label}`,
        subtitle: date,
        columns: ['Student', 'Now', 'New'],
        rows: rows.slice(0, MAX_ROWS_SHOWN).map(({ name, now, next }) => ({ name, now, next })),
        hiddenCount: Math.max(0, rows.length - MAX_ROWS_SHOWN),
        tally: Object.entries(tally).map(([label, count]) => ({ label, count })),
        note: left > 0 ? `${left} ${left === 1 ? 'student keeps their mark' : 'students keep their marks'}.` : null,
      },
    };
  },
});

defineTool({
  name: 'propose_scores',
  doing: 'Preparing marks',
  writes: true,
  description:
    'Prepare marks for one assessment of one class, for the person to apply. Each entry is a student\'s ref with a score (a number up to what the assessment is out of) and a status: "graded" for a score, "missing" (counts as zero, no score), or "excused" (never counts; the score is left as it is). Use get_gradebook first for the class, the assessment refs and what each is out of. Only name the students the person gave you.',
  parameters: {
    type: 'object',
    properties: {
      class: REF,
      assessment: REF,
      entries: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          properties: {
            student: REF,
            score: { type: ['number', 'null'], description: 'The mark, or null for missing or excused.' },
            status: { type: 'string', enum: ['graded', 'missing', 'excused'] },
          },
          required: ['student', 'score', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['class', 'assessment', 'entries'],
    additionalProperties: false,
  },
  views: STAFF,
  handler: async (args, ctx) => {
    const cls = ctx.refs.resolve(args.class, 'class');
    const assessmentRef = ctx.refs.resolve(args.assessment, 'assessment');
    const [{ data: assessments }, overlay] = await Promise.all([
      ctx.read('classAssessments', { params: { classId: cls.id } }),
      ctx.read('gridOverlay', { params: { classId: cls.id } }),
    ]);
    const assessment = (assessments || []).find((a) => a.assessmentId === assessmentRef.id);
    if (!assessment) throw new ToolError('NOT_IN_CLASS', `${assessmentRef.label} is not an assessment of ${cls.label}.`);
    if (assessment.isParent) throw new ToolError('CATEGORY', `${assessment.name} is a category: its marks come from the assessments inside it. Name one of those.`);
    const fromClasswork = ((overlay && overlay.data && overlay.data.items) || overlay.items || []).some((item) => item.assessmentId === assessment.assessmentId);
    if (fromClasswork) {
      throw new ToolError('FROM_CLASSWORK', `${assessment.name} is filled from an assignment or quiz in Classwork, so its marks are entered there, not in the gradebook. Use find_feature to show the person where.`);
    }
    const outOf = assessment.maxScore === null || assessment.maxScore === undefined ? 100 : Number(assessment.maxScore);
    const kindArgs = { classId: cls.id, assessmentId: assessment.assessmentId, outOf, assessmentName: assessment.name, className: cls.label };
    const current = await KINDS.scores.read(ctx.read, kindArgs);

    const targets = {};
    const before = {};
    const names = {};
    for (const entry of args.entries) {
      const student = ctx.refs.resolve(entry.student, 'student');
      if (!(student.id in current)) throw new ToolError('NOT_IN_CLASS', `${student.label} is not in ${cls.label}.`);
      const now = current[student.id];
      let next;
      if (entry.status === 'missing') next = { score: null, status: 'missing' };
      else if (entry.status === 'excused') next = { score: now.score, status: 'excused' }; // an excused cell keeps its score
      else {
        if (entry.score === null || !Number.isFinite(entry.score)) throw new ToolError('INVALID_SCORE', `Give ${student.label} a number, or mark them missing or excused.`);
        if (entry.score < 0 || entry.score > outOf) throw new ToolError('INVALID_SCORE', `${assessment.name} is out of ${outOf}: ${entry.score} is not a mark it can take.`);
        next = { score: entry.score, status: 'graded' };
      }
      if (!KINDS.scores.same(now, next)) {
        targets[student.id] = next;
        before[student.id] = now;
        names[student.id] = student.label;
      }
    }
    const keys = Object.keys(targets);
    if (keys.length === 0) {
      return { summary: 'Nothing to change', forModel: { prepared: false, note: `Those marks are already saved for ${assessment.name}. Tell the person nothing needed changing.` } };
    }
    const label = (value) => KINDS.scores.label(value, kindArgs);
    const rows = keys.map((key) => ({ key, name: names[key], now: label(before[key]), next: label(targets[key]) })).sort((a, b) => a.name.localeCompare(b.name));
    const title = `${assessment.name} · ${cls.label}`;
    const action = await ctx.propose({ kind: 'scores', title, args: { ...kindArgs, targets }, before, preview: { rows } });
    return {
      summary: `${keys.length} ${keys.length === 1 ? 'score' : 'scores'} ready to save`,
      forModel: { prepared: true, assessment: assessment.name, outOf, published: assessment.isPublished === true, changes: rows.slice(0, 40).map(({ name, now, next }) => ({ name, now, next })), note: PREPARED_NOTE },
      action,
      card: {
        type: 'change',
        actionId: action.id,
        title: `${assessment.name} · out of ${outOf}`,
        subtitle: cls.label,
        columns: ['Student', 'Now', 'New'],
        rows: rows.slice(0, MAX_ROWS_SHOWN).map(({ name, now, next }) => ({ name, now, next })),
        hiddenCount: Math.max(0, rows.length - MAX_ROWS_SHOWN),
        tally: null,
        note: assessment.isPublished
          ? 'This assessment is published: parents and students see these marks once you save.'
          : 'Not published yet: parents and students see nothing until you publish this assessment.',
      },
    };
  },
});
