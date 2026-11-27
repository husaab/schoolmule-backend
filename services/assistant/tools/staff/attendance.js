// services/assistant/tools/staff/attendance.js
//
// "Who was absent this week?": a class's marks, or the school's daily
// attendance, over a period, read through the attendance range routes with
// the person's own token (class attendance for the classes they may open,
// daily attendance with attendance.daily). Names and refs only.

const { defineTool } = require('../registry');
const { ToolError } = require('../../errors');

const STAFF = ['ADMIN', 'TEACHER'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'custom'];
const MAX_ROWS_SHOWN = 40;

const at = (day) => new Date(`${day}T12:00:00Z`);
const iso = (date) => date.toISOString().slice(0, 10);
const shift = (day, n) => { const d = at(day); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

/** The first and last day of a period, from today (the school's own date). A week starts on Monday. */
function periodOf(period, today, from, to) {
  const weekday = (at(today).getUTCDay() + 6) % 7; // Monday 0
  if (period === 'today') return { from: today, to: today, label: 'today' };
  if (period === 'yesterday') { const y = shift(today, -1); return { from: y, to: y, label: 'yesterday' }; }
  if (period === 'this_week') return { from: shift(today, -weekday), to: today, label: 'this week' };
  if (period === 'last_week') { const monday = shift(today, -weekday - 7); return { from: monday, to: shift(monday, 6), label: 'last week' }; }
  if (period === 'this_month') return { from: `${today.slice(0, 7)}-01`, to: today, label: 'this month' };
  if (period === 'last_month') {
    const first = at(`${today.slice(0, 7)}-01`);
    first.setUTCMonth(first.getUTCMonth() - 1);
    const start = iso(first);
    return { from: start, to: shift(`${today.slice(0, 7)}-01`, -1), label: 'last month' };
  }
  const real = (d) => typeof d === 'string' && ISO_DAY.test(d) && !Number.isNaN(at(d).getTime());
  if (!real(from) || !real(to)) throw new ToolError('INVALID_ARGUMENTS', 'For a custom period give from and to as days written YYYY-MM-DD.');
  if (from > to) throw new ToolError('INVALID_ARGUMENTS', 'from must not be after to.');
  if (to > today) return periodOf('custom', today, from, today);
  return { from, to, label: from === to ? from : `${from} to ${to}` };
}

defineTool({
  name: 'get_attendance_summary',
  doing: 'Reading attendance',
  description:
    'Who was absent or late over a period: one class\'s attendance, or (class null) the school\'s daily attendance. Use it for "who was absent this week", "how many times was Yusuf late this month" or "absences last week in Math". Periods: today, yesterday, this_week (Monday to today), last_week, this_month, last_month, or custom with from and to (YYYY-MM-DD, up to 92 days).',
  parameters: {
    type: 'object',
    properties: {
      class: { type: ['string', 'null'], description: 'A class ref, or null for the school\'s daily attendance.' },
      period: { type: 'string', enum: PERIODS },
      from: { type: ['string', 'null'], description: 'First day for a custom period (YYYY-MM-DD), else null.' },
      to: { type: ['string', 'null'], description: 'Last day for a custom period (YYYY-MM-DD), else null.' },
    },
    required: ['class', 'period', 'from', 'to'],
    additionalProperties: false,
  },
  views: STAFF,
  handler: async (args, ctx) => {
    const range = periodOf(args.period, ctx.today, args.from, args.to);
    const cls = args.class ? ctx.refs.resolve(args.class, 'class') : null;
    const query = { from: range.from, to: range.to };

    // Every mark, and who each student is.
    let marks;
    const people = new Map();
    if (cls) {
      const [{ data: roster }, { data }] = await Promise.all([
        ctx.read('classStudents', { params: { classId: cls.id } }),
        ctx.read('classAttendanceRange', { params: { classId: cls.id }, query }),
      ]);
      for (const s of roster || []) people.set(s.studentId, { name: s.name, grade: s.grade ?? null });
      marks = data || [];
    } else {
      const { data } = await ctx.read('generalAttendanceRange', { query });
      marks = data || [];
      for (const m of marks) if (!people.has(m.studentId)) people.set(m.studentId, { name: m.name, grade: m.grade ?? null });
    }

    const tally = new Map();
    const days = new Set();
    for (const m of marks) {
      if (!people.has(m.studentId)) continue; // no longer on the roster
      days.add(m.date);
      const t = tally.get(m.studentId) || { absent: 0, late: 0, excused: 0, present: 0, absentOn: [], lateOn: [] };
      if (m.status === 'ABSENT') { t.absent += 1; t.absentOn.push(m.date); }
      else if (m.status === 'LATE') { t.late += 1; t.lateOn.push(m.date); }
      else if (m.status === 'EXCUSED') t.excused += 1;
      else if (m.status === 'PRESENT') t.present += 1;
      tally.set(m.studentId, t);
    }
    const flagged = [...tally.entries()]
      .filter(([, t]) => t.absent > 0 || t.late > 0)
      .map(([id, t]) => ({ id, ...people.get(id), ...t }))
      .sort((a, b) => b.absent - a.absent || b.late - a.late || a.name.localeCompare(b.name));
    const students = flagged.map((s) => ({
      ref: ctx.refs.mint('student', s.id, s.name),
      name: s.name,
      ...(cls ? {} : { grade: s.grade }),
      absent: s.absent,
      late: s.late,
      excused: s.excused,
      absentOn: s.absentOn,
      lateOn: s.lateOn,
    }));
    const scope = cls ? cls.label : 'Daily attendance';
    const span = range.from === range.to ? range.from : `${range.from} to ${range.to}`;
    return {
      summary: days.size === 0
        ? `No attendance taken ${range.label}`
        : `${students.filter((s) => s.absent > 0).length} absent, ${students.filter((s) => s.late > 0).length} late ${range.label}`,
      forModel: {
        scope,
        from: range.from,
        to: range.to,
        daysWithAttendance: [...days].sort(),
        students,
        note: days.size === 0
          ? 'No attendance was taken on those days: say so, do not say everyone was present.'
          : 'Students not listed were present (or not marked) on every day attendance was taken.',
      },
      card: students.length
        ? {
            type: 'table',
            title: `${scope} · ${range.label}`,
            subtitle: `${span} · ${days.size} ${days.size === 1 ? 'day' : 'days'} taken`,
            tier: 'read',
            columns: [
              { key: 'name', label: 'Student' },
              { key: 'absent', label: 'Absent', align: 'right' },
              { key: 'late', label: 'Late', align: 'right' },
            ],
            rows: students.slice(0, MAX_ROWS_SHOWN).map((s) => ({ name: s.name, absent: s.absent, late: s.late })),
          }
        : null,
    };
  },
});

module.exports = { periodOf };
