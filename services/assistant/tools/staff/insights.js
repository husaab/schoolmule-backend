// services/assistant/tools/staff/insights.js
//
// Read tools for "how is my class doing?", "how is Yusuf doing?" and "who
// needs attention this term?". They read the same analytics the Analytics
// page shows (services/analyticsEngine.js, through /api/analytics with the
// person's own token, so the analytics permission applies), and find a
// student by name among those the person can open. Names and refs only:
// never an id, an education number or a contact detail.

const { defineTool } = require('../registry');
const { ToolError } = require('../../errors');

const STAFF = ['ADMIN', 'TEACHER'];
const REF = { type: 'string', description: 'A ref from an earlier tool result, such as "c1".' };
const MAX_ROWS_SHOWN = 40;

const pct = (value) => (value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10);
const shown = (value) => (value === null || value === undefined ? '—' : `${pct(value)}%`);
const classLabel = (c) => `${c.subject} · Grade ${c.grade}`;

/** The term analytics are read for: the school's active term, else the one today falls in. */
async function currentTerm(ctx) {
  for (const routeId of ['activeTerm', 'currentTerm']) {
    try {
      const { data } = await ctx.read(routeId);
      if (data && data.termId) return { id: data.termId, name: data.name || 'This term' };
    } catch (err) {
      if (!(err instanceof ToolError) || err.code !== 'NOT_FOUND') throw err;
    }
  }
  throw new ToolError('NO_TERM', 'The school has no current term set up, so there are no term results to read yet.');
}

defineTool({
  name: 'get_class_insights',
  doing: 'Reading how the class is doing',
  description:
    'How one class is doing this term, as the Analytics page counts it: the class average and median, each student\'s grade so far with missing and not-yet-graded work, and each assessment\'s class average. Use it for "how is my class doing", "who is struggling in Math" or "which test went badly". Needs a class ref.',
  parameters: { type: 'object', properties: { class: REF }, required: ['class'], additionalProperties: false },
  views: STAFF,
  handler: async (args, ctx) => {
    const cls = ctx.refs.resolve(args.class, 'class');
    const { data } = await ctx.read('analyticsClass', { params: { classId: cls.id } });
    const summary = (data && data.summary) || {};
    const stats = summary.stats || {};
    const students = (data.students || []).map((s) => ({
      ref: ctx.refs.mint('student', s.studentId, s.studentName),
      name: s.studentName,
      grade: pct(s.finalPct),
      missing: s.missingCount || 0,
      notYetGraded: s.notYetGradedCount || 0,
      leftOutOfClassAverage: Boolean(s.leftOut),
    }));
    const assessments = (data.assessments || [])
      .filter((a) => !a.isParent)
      .map((a) => ({
        ref: ctx.refs.mint('assessment', a.assessmentId, a.name),
        name: a.name,
        date: a.date || null,
        classAverage: a.stats ? pct(a.stats.avg) : null,
        graded: a.stats ? a.stats.count ?? null : null,
      }));
    const average = pct(stats.avg ?? summary.avgAll);
    return {
      summary: average === null ? `No grades yet in ${cls.label}` : `Class average ${average}% in ${cls.label}`,
      forModel: {
        class: cls.label,
        classAverage: average,
        median: pct(stats.median ?? summary.medianAll),
        leftOutOfClassAverage: summary.leftOutCount || 0,
        students,
        assessments,
        note: 'A grade is the term grade so far: blank cells carry no weight, missing counts as zero. Say which students need attention and why, briefly.',
      },
      card: students.length
        ? {
            type: 'table',
            title: `${cls.label} · this term`,
            subtitle: average === null ? 'No grades yet' : `Class average ${average}%`,
            tier: 'read',
            columns: [
              { key: 'name', label: 'Student' },
              { key: 'grade', label: 'Grade', align: 'right' },
              { key: 'missing', label: 'Missing', align: 'right' },
            ],
            rows: students.slice(0, MAX_ROWS_SHOWN).map((s) => ({ name: s.name, grade: shown(s.grade), missing: s.missing })),
          }
        : null,
    };
  },
});

defineTool({
  name: 'find_student',
  doing: 'Looking for the student',
  description:
    'Find students by name among those this person can open, each with a ref. Use it when the person names a student and you have no ref yet, and no class to read a roster from. If more than one student matches, ask the person to choose.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The name, or part of it, as the person wrote it.' } },
    required: ['name'],
    additionalProperties: false,
  },
  views: STAFF,
  handler: async (args, ctx) => {
    const words = String(args.name || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) throw new ToolError('INVALID_ARGUMENTS', 'Give a name to look for.');
    const matches = (people) => people.filter((p) => words.every((w) => p.name.toLowerCase().includes(w)));

    let found = [];
    try {
      // Staff who can see the whole school's student list.
      const { data } = await ctx.read('students');
      found = matches((data || []).map((s) => ({ id: s.studentId || s.student_id, name: s.name, grade: s.grade ?? null, where: null })).filter((s) => s.id && s.name));
    } catch (err) {
      if (!(err instanceof ToolError) || err.code !== 'FORBIDDEN') throw err;
      // A teacher who can't: the students of the classes they can open.
      const { data: classes } = await ctx.read('classes');
      const open = (classes || []).filter((c) => !c.archivedAt).slice(0, 40);
      const seen = new Map();
      for (const c of open) {
        const { data: roster } = await ctx.read('classStudents', { params: { classId: c.classId } });
        for (const s of roster || []) {
          if (!seen.has(s.studentId)) seen.set(s.studentId, { id: s.studentId, name: s.name, grade: s.grade ?? null, where: classLabel(c) });
        }
      }
      found = matches([...seen.values()]);
    }
    found.sort((a, b) => a.name.localeCompare(b.name));
    const students = found.slice(0, 20).map((s) => ({ ref: ctx.refs.mint('student', s.id, s.name), name: s.name, grade: s.grade, ...(s.where && { inClass: s.where }) }));
    return {
      summary: students.length === 0 ? 'No student by that name' : `${found.length} ${found.length === 1 ? 'student' : 'students'} found`,
      forModel: { students, more: Math.max(0, found.length - students.length) },
    };
  },
});

defineTool({
  name: 'get_student_insights',
  doing: 'Reading how the student is doing',
  description:
    'How one student is doing this term across their classes, as the Analytics page counts it: their grade in each class beside the class average, missing and not-yet-graded work, their attendance and their overall average. Use it for "how is Yusuf doing" or "is Sara behind anywhere". Needs a student ref (find_student or a roster).',
  parameters: { type: 'object', properties: { student: REF }, required: ['student'], additionalProperties: false },
  views: STAFF,
  handler: async (args, ctx) => {
    const student = ctx.refs.resolve(args.student, 'student');
    const term = await currentTerm(ctx);
    const { data } = await ctx.read('analyticsStudent', { params: { studentId: student.id }, query: { termId: term.id } });
    if (!data) throw new ToolError('NOT_FOUND', `${student.label} has no grades in ${term.name}.`);
    const classes = (data.classes || []).map((c) => ({
      class: `${c.subject}`,
      teacher: c.teacherName || null,
      grade: pct(c.finalPct),
      classAverage: pct(c.classAvg),
      missing: c.missingCount || 0,
      notYetGraded: c.notYetGradedCount || 0,
    }));
    const overall = data.overall ? pct(data.overall.avg) : null;
    const attendance = data.attendance ? pct(data.attendance.pct) : null;
    return {
      summary: overall === null ? `No grades yet for ${student.label}` : `${student.label}: ${overall}% overall`,
      forModel: { student: student.label, term: term.name, overallAverage: overall, attendancePercent: attendance, classes, note: 'Say plainly where they are doing well and where they are behind, with the class average for context.' },
      card: classes.length
        ? {
            type: 'table',
            title: `${student.label} · ${term.name}`,
            subtitle: [overall === null ? null : `Overall ${overall}%`, attendance === null ? null : `Attendance ${attendance}%`].filter(Boolean).join(' · ') || undefined,
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
  name: 'get_students_needing_attention',
  doing: 'Looking for students who need attention',
  description:
    'Students across the school who may need attention this term: a low overall average, missing work, or low attendance, with their weakest subject. Use it for "who is struggling", "who is at risk" or "who has the most missing work". Optional grade filter.',
  parameters: {
    type: 'object',
    properties: { grade: { type: ['string', 'null'], description: 'Only this grade level (such as "6"), or null for every grade.' } },
    required: ['grade'],
    additionalProperties: false,
  },
  views: STAFF,
  handler: async (args, ctx) => {
    const term = await currentTerm(ctx);
    const { data } = await ctx.read('analyticsSnapshot', { query: { termId: term.id } });
    const flagged = [];
    for (const s of (data && data.students) || []) {
      if (args.grade && String(s.gradeLevel) !== String(args.grade)) continue;
      const reasons = [];
      if (s.overallAvg !== null && s.overallAvg < 60) reasons.push(`overall ${pct(s.overallAvg)}%`);
      if (s.missingCount >= 3) reasons.push(`${s.missingCount} missing`);
      if (s.attendancePct !== null && s.attendancePct < 90) reasons.push(`attendance ${pct(s.attendancePct)}%`);
      if (reasons.length === 0) continue;
      flagged.push({ id: s.studentId, name: s.studentName, grade: s.gradeLevel, overall: pct(s.overallAvg), missing: s.missingCount, attendance: pct(s.attendancePct), weakest: s.lowestSubject ? `${s.lowestSubject} (${pct(s.lowestPct)}%)` : null, reasons });
    }
    // Lowest overall first; no grades at all sorts after the rest.
    flagged.sort((a, b) => (a.overall ?? 101) - (b.overall ?? 101) || b.missing - a.missing || a.name.localeCompare(b.name));
    const list = flagged.slice(0, 30).map((s) => ({ ref: ctx.refs.mint('student', s.id, s.name), name: s.name, grade: s.grade, overall: s.overall, missing: s.missing, attendance: s.attendance, weakestSubject: s.weakest, why: s.reasons }));
    return {
      summary: list.length === 0 ? `Nobody flagged in ${term.name}` : `${flagged.length} ${flagged.length === 1 ? 'student' : 'students'} to look at`,
      forModel: {
        term: term.name,
        rule: 'Flagged when the overall average is under 60%, 3 or more pieces of work are missing, or attendance is under 90%. These are prompts to look, not judgements: give the reasons, do not label anyone.',
        students: list,
        more: Math.max(0, flagged.length - list.length),
      },
      card: list.length
        ? {
            type: 'table',
            title: `Students to look at · ${term.name}`,
            subtitle: 'Under 60% overall, 3+ missing, or attendance under 90%',
            tier: 'read',
            columns: [
              { key: 'name', label: 'Student' },
              { key: 'overall', label: 'Overall', align: 'right' },
              { key: 'missing', label: 'Missing', align: 'right' },
              { key: 'attendance', label: 'Attend.', align: 'right' },
            ],
            rows: list.slice(0, MAX_ROWS_SHOWN).map((s) => ({ name: s.name, overall: shown(s.overall), missing: s.missing, attendance: shown(s.attendance) })),
          }
        : null,
    };
  },
});

const MAX_CLASSES_READ = 24;

defineTool({
  name: 'get_top_students',
  doing: 'Ranking students',
  description:
    'Rank students by their term grade so far: the highest (or lowest) overall average in a grade or the whole school, or the highest (or lowest) grade in one subject across all its classes (such as every Math class), optionally in one grade. Use it for "who is the top student in Grade 6", "best in Math", "lowest marks in Science". Students left out of a class average are not ranked in that subject.',
  parameters: {
    type: 'object',
    properties: {
      grade: { type: ['string', 'null'], description: 'One grade (such as "6"), or null for every grade.' },
      subject: { type: ['string', 'null'], description: 'A subject (such as "Math"), or null to rank by the overall average across all subjects.' },
      order: { type: 'string', enum: ['highest', 'lowest'] },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many to list (10 unless they asked for a number).' },
    },
    required: ['grade', 'subject', 'order', 'limit'],
    additionalProperties: false,
  },
  views: STAFF,
  handler: async (args, ctx) => {
    const limit = Math.min(50, Math.max(1, args.limit || 10));
    const grade = args.grade ? String(args.grade).trim() : null;
    const byScore = (a, b) => (args.order === 'lowest' ? a.score - b.score : b.score - a.score) || a.name.localeCompare(b.name);
    let ranked = [];
    let basis;
    let scope;
    let leftOut = 0;
    let partial = false;

    if (args.subject) {
      const wanted = String(args.subject).trim().toLowerCase();
      const { data: classes } = await ctx.read('classes');
      let matching = (classes || []).filter((c) => !c.archivedAt && String(c.subject || '').toLowerCase().includes(wanted) && (!grade || String(c.grade) === grade));
      if (matching.length === 0) throw new ToolError('NO_CLASSES', `No ${args.subject} classes${grade ? ` in Grade ${grade}` : ''} were found.`);
      // A class belongs to one term: rank this term's classes when there are any.
      const term = await currentTerm(ctx).catch((err) => {
        if (err instanceof ToolError && err.code === 'NO_TERM') return null;
        throw err;
      });
      if (term && matching.some((c) => c.termId === term.id)) matching = matching.filter((c) => c.termId === term.id);
      partial = matching.length > MAX_CLASSES_READ;
      const rows = [];
      for (const c of matching.slice(0, MAX_CLASSES_READ)) {
        try {
          const { data } = await ctx.read('analyticsClass', { params: { classId: c.classId } });
          for (const s of (data && data.students) || []) {
            if (s.leftOut) { leftOut += 1; continue; }
            if (s.finalPct === null || s.finalPct === undefined) continue;
            rows.push({ id: s.studentId, name: s.studentName, score: Number(s.finalPct), where: classLabel(c), coverage: s.coverage || null });
          }
        } catch (err) {
          if (!(err instanceof ToolError) || err.code === 'FORBIDDEN') throw err;
          // A class with no term or no grades yet has nothing to rank.
        }
      }
      // Someone in two matching classes is ranked once, by their better (or worse) grade.
      const best = new Map();
      for (const r of rows) {
        const had = best.get(r.id);
        if (!had || (args.order === 'lowest' ? r.score < had.score : r.score > had.score)) best.set(r.id, r);
      }
      ranked = [...best.values()];
      basis = `term grade so far in ${args.subject}${term ? `, ${term.name}` : ''}`;
      scope = `${args.subject}${grade ? ` · Grade ${grade}` : ' · every grade'}`;
    } else {
      const term = await currentTerm(ctx);
      const { data } = await ctx.read('analyticsSnapshot', { query: { termId: term.id } });
      ranked = ((data && data.students) || [])
        .filter((s) => s.overallAvg !== null && s.overallAvg !== undefined && (!grade || String(s.gradeLevel) === grade))
        .map((s) => ({ id: s.studentId, name: s.studentName, score: Number(s.overallAvg), where: s.gradeLevel ? `Grade ${s.gradeLevel}` : null, classes: s.classCount }));
      basis = `overall average across their classes, ${term.name}`;
      scope = grade ? `Grade ${grade}` : 'Whole school';
    }
    if (ranked.length === 0) {
      return { summary: 'No grades to rank yet', forModel: { scope, ranked: [], note: 'Nobody in that group has graded work yet, so there is no ranking. Say so.' } };
    }
    ranked.sort(byScore);
    // Equal grades share a place (1, 2, 2, 4).
    let place = 0;
    const list = ranked.slice(0, limit).map((r, i, all) => {
      if (i === 0 || r.score !== all[i - 1].score) place = i + 1;
      return {
        place,
        ref: ctx.refs.mint('student', r.id, r.name),
        name: r.name,
        grade: pct(r.score),
        ...(r.where && { [args.subject ? 'class' : 'gradeLevel']: r.where }),
        ...(r.coverage && { gradedWork: `${r.coverage.assessed ?? '?'} of ${r.coverage.total ?? '?'}` }),
      };
    });
    return {
      summary: `${args.order === 'lowest' ? 'Lowest' : 'Top'} ${list.length} · ${scope}`,
      forModel: {
        scope,
        order: args.order,
        basis,
        ranked: list,
        outOf: ranked.length,
        ...(leftOut > 0 && { leftOutOfClassAverages: leftOut }),
        ...(partial && { note: `Only the first ${MAX_CLASSES_READ} classes were read.` }),
        howToSay: 'Give the ranking with each grade and what it is based on. A grade on little graded work can move a lot; mention it when gradedWork is low.',
      },
      card: {
        type: 'table',
        title: `${args.order === 'lowest' ? 'Lowest' : 'Top'} students · ${scope}`,
        subtitle: `By ${basis} · ${ranked.length} ranked`,
        tier: 'read',
        columns: [
          { key: 'place', label: '#', align: 'right' },
          { key: 'name', label: 'Student' },
          { key: 'where', label: args.subject ? 'Class' : 'Grade' },
          { key: 'grade', label: args.subject ? 'Grade' : 'Overall', align: 'right' },
        ],
        rows: list.map((r) => ({ place: r.place, name: r.name, where: r.class || r.gradeLevel || '—', grade: shown(r.grade) })),
      },
    };
  },
});

