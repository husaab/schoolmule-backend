// services/assistant/tools/parent/family.js
//
// Muley for a parent or guardian: read tools over the parent portal's own
// routes (/api/parent-portal, with their token), so they see exactly what the
// portal shows them: their own children, the grades teachers have published,
// attendance, what is due, the school calendar and parent-teacher meetings.
// Names and refs only: never an id, an education number or a contact detail.

const { defineTool } = require('../registry');
const { ToolError } = require('../../errors');
const { periodOf } = require('../staff/attendance');

const PARENT = ['PARENT'];
const CHILD = { type: 'string', description: 'A child\'s ref from list_my_children, such as "s1".' };
const pct = (value) => (value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10);
const shown = (value) => (value === null || value === undefined ? '—' : `${pct(value)}%`);
const dayOf = (value) => (value ? String(value).slice(0, 10) : null);
const timeOf = (minutes) => {
  if (minutes === null || minutes === undefined) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

defineTool({
  name: 'list_my_children',
  doing: 'Looking up your children',
  description:
    'This parent\'s children at the school, each with a ref, their grade, their overall average this term (from published grades), their attendance and their homeroom teacher, and the next school event. Call it first: other tools need a child\'s ref.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  views: PARENT,
  handler: async (_args, ctx) => {
    const { data } = await ctx.read('parentSummary');
    const children = ((data && data.children) || []).map((c) => ({
      ref: ctx.refs.mint('student', c.studentId, c.name),
      name: c.name,
      grade: c.grade ?? null,
      homeroomTeacher: c.homeroomTeacher || null,
      overallAverage: pct(c.overallAvg),
      attendancePercent: c.attendance ? pct(c.attendance.pct) : null,
    }));
    const next = data && data.nextEvent ? { title: data.nextEvent.title, date: dayOf(data.nextEvent.startDate), schoolClosed: Boolean(data.nextEvent.isSchoolClosed) } : null;
    return {
      summary: `${children.length} ${children.length === 1 ? 'child' : 'children'}`,
      forModel: { children, nextSchoolEvent: next },
    };
  },
});

defineTool({
  name: 'get_child_grades',
  doing: 'Reading the grades',
  description:
    'One child\'s grades this term, as the parent portal shows them: each class with the teacher, their grade so far, the class average when the school shows it, and missing or not-yet-graded work, plus the list of missing work. Only published grades are included.',
  parameters: { type: 'object', properties: { child: CHILD }, required: ['child'], additionalProperties: false },
  views: PARENT,
  handler: async (args, ctx) => {
    const child = ctx.refs.resolve(args.child, 'student');
    const { data } = await ctx.read('parentChildGrades', { params: { studentId: child.id } });
    const classes = ((data && data.classes) || []).map((c) => ({
      class: c.subject,
      teacher: c.teacherName || null,
      grade: pct(c.finalPct),
      classAverage: pct(c.classAvg),
      missing: c.missingCount || 0,
      notYetGraded: c.notYetGradedCount || 0,
    }));
    const missingWork = ((data && data.missingWork) || []).filter((m) => !m.isParent).map((m) => ({ class: m.subject, work: m.assessmentName, date: dayOf(m.assessmentDate) }));
    const overall = data && data.overall ? pct(data.overall.avg) : null;
    return {
      summary: overall === null ? `No published grades yet for ${child.label}` : `${child.label}: ${overall}% overall`,
      forModel: { child: child.label, overallAverage: overall, classes, missingWork, note: 'Only grades the teachers have published are here.' },
      card: classes.length
        ? {
            type: 'table',
            title: `${child.label} · this term`,
            subtitle: overall === null ? 'No published grades yet' : `Overall ${overall}%`,
            tier: 'read',
            columns: [
              { key: 'class', label: 'Class' },
              { key: 'grade', label: 'Grade', align: 'right' },
              { key: 'average', label: 'Class avg', align: 'right' },
              { key: 'missing', label: 'Missing', align: 'right' },
            ],
            rows: classes.map((c) => ({ class: c.class, grade: shown(c.grade), average: shown(c.classAverage), missing: c.missing })),
          }
        : null,
    };
  },
});

defineTool({
  name: 'get_child_attendance',
  doing: 'Reading attendance',
  description:
    'One child\'s daily attendance over a period: days present, late and absent, and which days. Periods: today, yesterday, this_week (Monday to today), last_week, this_month, last_month, or custom with from and to (YYYY-MM-DD).',
  parameters: {
    type: 'object',
    properties: {
      child: CHILD,
      period: { type: 'string', enum: ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'custom'] },
      from: { type: ['string', 'null'], description: 'First day for a custom period, else null.' },
      to: { type: ['string', 'null'], description: 'Last day for a custom period, else null.' },
    },
    required: ['child', 'period', 'from', 'to'],
    additionalProperties: false,
  },
  views: PARENT,
  handler: async (args, ctx) => {
    const child = ctx.refs.resolve(args.child, 'student');
    const range = periodOf(args.period, ctx.today, args.from, args.to);
    const { data } = await ctx.read('parentChildAttendance', { params: { studentId: child.id }, query: { from: range.from, to: range.to } });
    const days = ((data && data.days) || []).map((d) => ({ date: dayOf(d.date), status: d.status }));
    const s = (data && data.summary) || {};
    const absentOn = days.filter((d) => d.status === 'ABSENT').map((d) => d.date);
    const lateOn = days.filter((d) => d.status === 'LATE').map((d) => d.date);
    return {
      summary: days.length === 0 ? `No attendance taken ${range.label}` : `${child.label}: ${absentOn.length} absent, ${lateOn.length} late ${range.label}`,
      forModel: {
        child: child.label, from: range.from, to: range.to,
        daysTaken: s.totalDays ?? days.length, present: s.presentDays ?? null, late: s.lateDays ?? lateOn.length, absent: s.absentDays ?? absentOn.length,
        absentOn, lateOn,
        note: days.length === 0 ? 'No attendance was taken on those days: say so.' : undefined,
      },
    };
  },
});

defineTool({
  name: 'get_whats_due',
  doing: 'Looking at classwork',
  description:
    'For each child: how much classwork is due in the next seven days, how much is missing, and new grades from the last few days, from their classes in School Mule\'s classroom. Use it for "what homework is due" or "is anything missing".',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  views: PARENT,
  handler: async (_args, ctx) => {
    const { data } = await ctx.read('parentClassroomSummary');
    const list = Array.isArray(data) ? data : (data && (data.children || data.students)) || [];
    const children = list.map((c) => ({
      ref: ctx.refs.mint('student', c.studentId, c.name),
      name: c.name,
      classes: c.classCount ?? null,
      dueThisWeek: c.dueThisWeek ?? 0,
      missing: c.missingCount ?? 0,
      newGrades: c.newGradeCount ?? 0,
    }));
    return {
      summary: children.length === 0 ? 'No classroom classes yet' : `${children.reduce((n, c) => n + c.dueThisWeek, 0)} due this week`,
      forModel: { children, note: 'Counts only: the Classes page lists each piece of work. Offer to show them where it is.' },
      card: children.length
        ? {
            type: 'table',
            title: 'Classwork',
            subtitle: 'Due in the next 7 days, missing, and new grades',
            tier: 'read',
            columns: [
              { key: 'name', label: 'Child' },
              { key: 'due', label: 'Due', align: 'right' },
              { key: 'missing', label: 'Missing', align: 'right' },
              { key: 'grades', label: 'New grades', align: 'right' },
            ],
            rows: children.map((c) => ({ name: c.name, due: c.dueThisWeek, missing: c.missing, grades: c.newGrades })),
          }
        : null,
    };
  },
});

defineTool({
  name: 'get_school_calendar',
  doing: 'Reading the school calendar',
  description:
    'School events between two days: holidays, PA days, closures and other events on the school calendar. Use it for "is there school on Friday", "when is the next PA day" or "what\'s on this month". from and to are YYYY-MM-DD; for "next" questions look about three months ahead.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'First day (YYYY-MM-DD).' },
      to: { type: 'string', description: 'Last day (YYYY-MM-DD), at most a year after from.' },
    },
    required: ['from', 'to'],
    additionalProperties: false,
  },
  views: PARENT,
  handler: async (args, ctx) => {
    const ISO = /^\d{4}-\d{2}-\d{2}$/;
    if (!ISO.test(args.from) || !ISO.test(args.to) || args.from > args.to) throw new ToolError('INVALID_ARGUMENTS', 'from and to must be days written YYYY-MM-DD, from first.');
    const { data } = await ctx.read('parentCalendar', { query: { from: args.from, to: args.to } });
    const events = (data || []).slice(0, 60).map((e) => ({
      title: e.title,
      category: e.category || null,
      from: dayOf(e.startDate),
      to: dayOf(e.endDate),
      schoolClosed: Boolean(e.isSchoolClosed),
      notes: e.notes ? String(e.notes).slice(0, 200) : null,
    }));
    return {
      summary: `${events.length} ${events.length === 1 ? 'event' : 'events'}`,
      forModel: { from: args.from, to: args.to, events },
      card: events.length
        ? {
            type: 'table',
            title: 'School calendar',
            subtitle: `${args.from} to ${args.to}`,
            tier: 'read',
            columns: [{ key: 'when', label: 'When' }, { key: 'title', label: 'Event' }],
            rows: events.slice(0, 30).map((e) => ({ when: e.from === e.to || !e.to ? e.from : `${e.from} – ${e.to}`, title: e.schoolClosed ? `${e.title} (no school)` : e.title })),
          }
        : null,
    };
  },
});

defineTool({
  name: 'get_meetings',
  doing: 'Looking at parent-teacher meetings',
  description:
    'Parent-teacher meetings this family can book: each meeting round with its days and when booking closes, the teachers they can meet and how many times are still open, and the meetings they have booked. Booking is done on the Meetings page.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  views: PARENT,
  handler: async (_args, ctx) => {
    const { data } = await ctx.read('parentMeetings');
    const rounds = ((data && data.events) || []).map((e) => {
      const dayById = new Map((e.days || []).map((d) => [d.dayId, d]));
      const childName = new Map((e.children || []).map((c) => [c.studentId, c.name]));
      return {
        title: e.title,
        days: (e.days || []).map((d) => ({ date: dayOf(d.date), from: timeOf(d.start), to: timeOf(d.end), stillBookable: Boolean(d.bookable) })),
        teachers: (e.teachers || []).map((t) => ({
          name: t.name,
          for: (t.studentIds || []).map((id) => childName.get(id)).filter(Boolean),
          openTimes: (t.days || []).reduce((n, d) => n + ((d.open && d.open.length) || 0), 0),
        })),
        booked: (e.bookings || []).map((b) => ({
          teacher: b.teacherName,
          date: dayById.get(b.dayId) ? dayOf(dayById.get(b.dayId).date) : null,
          time: timeOf(b.start),
          for: (b.studentIds || []).map((id) => childName.get(id)).filter(Boolean),
          canChange: Boolean(b.canChange),
        })),
      };
    });
    const booked = rounds.flatMap((r) => r.booked);
    return {
      summary: rounds.length === 0 ? 'No meetings to book' : `${booked.length} booked`,
      forModel: { rounds, note: rounds.length === 0 ? 'There are no parent-teacher meetings open for this family right now.' : 'To book, move or cancel, they use the Meetings page: offer to show them where it is.' },
      card: booked.length
        ? {
            type: 'table',
            title: 'Your meetings',
            tier: 'read',
            columns: [{ key: 'when', label: 'When' }, { key: 'teacher', label: 'Teacher' }],
            rows: booked.map((b) => ({ when: [b.date, b.time].filter(Boolean).join(' · '), teacher: b.teacher })),
          }
        : null,
    };
  },
});
