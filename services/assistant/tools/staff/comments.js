// services/assistant/tools/staff/comments.js
//
// Report card comments (grades 1-8). get_report_card_comments reads what the
// teacher needs to write them: each student's saved comment and learning
// skills, the details the teacher picked to help, their term grade, the
// pronouns the school records, and the school's word limits and lock.
// propose_report_card_comments takes the comments Muley wrote and prepares
// them: the teacher reads each one on the card, and nothing is saved until
// they press Save (through the same route and rules as the comments page).
// JK and SK comments live on the kindergarten pages and are not covered.

const { defineTool } = require('../registry');
const { ToolError } = require('../../errors');
const { KINDS } = require('../../actions/kinds');
const { countWords } = require('../../../../utils/wordCount');

const STAFF = ['ADMIN', 'TEACHER'];
const REF = { type: 'string', description: 'A ref from an earlier tool result, such as "c1".' };
const RATING = { E: 'Excellent', G: 'Good', S: 'Satisfactory', N: 'Needs Improvement' };
const PRONOUNS = { male: 'he/him', female: 'she/her' };
const COMMENT_MAX_CHARS = 4000;
const MAX_ROWS_SHOWN = 40;

const pct = (value) => (value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10);
const classLabel = (c) => `${c.subject} · Grade ${c.grade}`;
const isKindergarten = (grade) => grade === 'JK' || grade === 'SK';

const WRITING_GUIDE = [
  'Write each comment in the third person, with the student\'s first name and the pronouns given (they/them when none is recorded).',
  'Warm, professional and honest, for parents to read: one clear strength and one clear next step, ending on a forward-looking note.',
  'Base it on the teacher\'s details and note when there are any, and on the learning skills and the grade; never invent units, projects or events.',
  'Never state the exact percentage or the letter ratings (E, G, S, N), and never compare the student with the class when their marks are modified.',
  'No medical, health or family matters, even if a note mentions them.',
  'Keep within the school\'s word limits; with no limits, 3 to 5 sentences.',
].join(' ');

/** The class, refusing a kindergarten class or one with no term. */
async function classFor(ctx, ref) {
  const cls = ctx.refs.resolve(ref, 'class');
  const { data } = await ctx.read('class', { params: { classId: cls.id } });
  if (data && isKindergarten(String(data.grade))) {
    throw new ToolError('KINDERGARTEN', 'JK and SK comments are written on the kindergarten report pages, not here.');
  }
  if (data && !data.termId) throw new ToolError('NO_TERM', `${cls.label} has no term set, so report card comments can't be written for it yet.`);
  return { ...cls, term: data ? data.termName || null : null };
}

/** The school's limits and lock for report cards in this class. */
async function rulesFor(ctx, classId) {
  const { data } = await ctx.read('reportCommentRules', { params: { classId } });
  const rules = (data && data.reportCard) || {};
  return { minWords: rules.minWords ?? null, maxWords: rules.maxWords ?? null, locked: Boolean(rules.locked), canEditLocked: Boolean(data && data.canEditLocked) };
}

defineTool({
  name: 'get_report_card_comments',
  doing: 'Reading report card comments',
  description:
    'Everything needed to write report card comments for one class (grades 1-8): each student\'s saved comment and word count, their learning skills (work habits, behaviour), the details and note the teacher picked to help, their term grade and missing work, their pronouns, and the school\'s word limits and review lock. Read it before propose_report_card_comments.',
  parameters: { type: 'object', properties: { class: REF }, required: ['class'], additionalProperties: false },
  views: STAFF,
  handler: async (args, ctx) => {
    const cls = await classFor(ctx, args.class);
    const [{ data: roster }, { data: feedback }, rules] = await Promise.all([
      ctx.read('classStudents', { params: { classId: cls.id } }),
      ctx.read('reportCardFeedback', { params: { classId: cls.id } }),
      rulesFor(ctx, cls.id),
    ]);
    // Grades are context: without the analytics permission the comments are written without them.
    let grades = new Map();
    try {
      const { data } = await ctx.read('analyticsClass', { params: { classId: cls.id } });
      grades = new Map(((data && data.students) || []).map((s) => [s.studentId, { grade: pct(s.finalPct), missing: s.missingCount || 0 }]));
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
    }
    const saved = new Map((feedback || []).map((f) => [f.studentId, f]));
    const students = (roster || [])
      .map((s) => ({ id: s.studentId, name: s.name, gender: s.gender || null }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => {
        const f = saved.get(s.id) || {};
        const g = grades.get(s.id) || {};
        const details = f.commentDetails && (Object.keys(f.commentDetails.picks || {}).length || f.commentDetails.note)
          ? { picks: f.commentDetails.picks || {}, note: f.commentDetails.note || null }
          : null;
        return {
          ref: ctx.refs.mint('student', s.id, s.name),
          name: s.name,
          pronouns: PRONOUNS[s.gender] || 'they/them',
          workHabits: RATING[f.workHabits] || null,
          behaviour: RATING[f.behavior] || null,
          termGrade: g.grade ?? null,
          missingWork: g.missing ?? null,
          teacherDetails: details,
          comment: f.comment || null,
          commentWords: f.comment ? countWords(f.comment) : 0,
        };
      });
    const written = students.filter((s) => s.comment).length;
    return {
      summary: `${written} of ${students.length} comments written in ${cls.label}`,
      forModel: {
        class: cls.label,
        term: cls.term,
        wordLimits: { min: rules.minWords, max: rules.maxWords },
        locked: rules.locked && !rules.canEditLocked,
        students,
        writingGuide: WRITING_GUIDE,
        note: rules.locked && !rules.canEditLocked
          ? 'Comments for this class are locked while the school reviews them: you can read them but not prepare changes.'
          : 'To write or rewrite comments, call propose_report_card_comments with the text; the teacher reads each one before saving.',
      },
      card: {
        type: 'table',
        title: `Report card comments · ${cls.label}`,
        subtitle: [cls.term, `${written} of ${students.length} written`, rules.maxWords ? `up to ${rules.maxWords} words` : null].filter(Boolean).join(' · '),
        tier: 'read',
        columns: [
          { key: 'name', label: 'Student' },
          { key: 'skills', label: 'Skills' },
          { key: 'words', label: 'Words', align: 'right' },
        ],
        rows: students.slice(0, MAX_ROWS_SHOWN).map((s) => ({
          name: s.name,
          skills: [s.workHabits, s.behaviour].filter(Boolean).map((r) => r[0]).join(' / ') || '—',
          words: s.commentWords || '—',
        })),
      },
    };
  },
});

defineTool({
  name: 'propose_report_card_comments',
  doing: 'Preparing report card comments',
  writes: true,
  description:
    'Prepare report card comments you wrote for students of one class, for the teacher to read and save. Each entry is a student\'s ref and the full comment text. Call get_report_card_comments first, follow its writingGuide and word limits, and only write for the students the teacher asked about (or every student without a comment, when they asked for all). The learning skills are kept as they are.',
  parameters: {
    type: 'object',
    properties: {
      class: REF,
      entries: {
        type: 'array',
        minItems: 1,
        maxItems: 60,
        items: {
          type: 'object',
          properties: { student: REF, comment: { type: 'string', description: 'The whole comment, as it should print.' } },
          required: ['student', 'comment'],
          additionalProperties: false,
        },
      },
    },
    required: ['class', 'entries'],
    additionalProperties: false,
  },
  views: STAFF,
  handler: async (args, ctx) => {
    const cls = await classFor(ctx, args.class);
    const kind = KINDS.report_card_comment;
    const [{ data: roster }, current, rules] = await Promise.all([
      ctx.read('classStudents', { params: { classId: cls.id } }),
      kind.read(ctx.read, { classId: cls.id }),
      rulesFor(ctx, cls.id),
    ]);
    if (rules.locked && !rules.canEditLocked) {
      throw new ToolError('COMMENTS_LOCKED', 'Report card comments for this class are locked while the school reviews them, so nothing can be prepared.');
    }
    const inClass = new Set((roster || []).map((s) => s.studentId));

    const targets = {};
    const before = {};
    const rows = [];
    const tooLong = [];
    for (const entry of args.entries) {
      const student = ctx.refs.resolve(entry.student, 'student');
      if (!inClass.has(student.id)) throw new ToolError('NOT_IN_CLASS', `${student.label} is not in ${cls.label}.`);
      const text = String(entry.comment || '').replace(/\s+\n/g, '\n').trim().slice(0, COMMENT_MAX_CHARS);
      if (!text) throw new ToolError('EMPTY_COMMENT', `Write a comment for ${student.label}, or leave them out.`);
      const words = countWords(text);
      if (rules.maxWords && words > rules.maxWords) tooLong.push(`${student.label} (${words} words)`);
      const now = kind.valueOf(current, student.id);
      if (kind.same(now, { comment: text })) continue;
      targets[student.id] = { comment: text };
      before[student.id] = now;
      rows.push({ key: student.id, name: student.label, now: now.comment, next: text, words });
    }
    if (tooLong.length > 0) {
      throw new ToolError('COMMENT_TOO_LONG', `The school allows at most ${rules.maxWords} words: ${tooLong.join(', ')} ${tooLong.length === 1 ? 'is' : 'are'} over. Shorten ${tooLong.length === 1 ? 'it' : 'them'} and prepare again.`);
    }
    if (rows.length === 0) {
      return { summary: 'Nothing to change', forModel: { prepared: false, note: 'Those comments are already saved exactly as written. Tell the teacher nothing needed changing.' } };
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    const short = rules.minWords ? rows.filter((r) => r.words < rules.minWords).map((r) => r.name) : [];

    const action = await ctx.propose({
      kind: 'report_card_comment',
      title: `Report card comments · ${cls.label}`,
      args: { classId: cls.id, className: cls.label, targets },
      before,
      // The log shows the start of each comment; the card shows all of it.
      preview: { rows: rows.map(({ key, name, now, next }) => ({ key, name, now: kind.label({ comment: now }), next: kind.label({ comment: next }) })) },
    });
    return {
      summary: `${rows.length} ${rows.length === 1 ? 'comment' : 'comments'} ready to read and save`,
      forModel: {
        prepared: true,
        class: cls.label,
        comments: rows.map(({ name, words }) => ({ name, words })),
        underMinimum: short,
        note: 'The teacher now sees every comment in full with a Save button. Nothing is saved until they press it. In one or two sentences, say what you wrote and that they can edit or ask you to change any of them before saving. Do not say they were saved.',
      },
      action,
      card: {
        type: 'comment_change',
        actionId: action.id,
        title: 'Report card comments',
        subtitle: [cls.label, cls.term].filter(Boolean).join(' · '),
        items: rows.slice(0, MAX_ROWS_SHOWN).map(({ name, now, next, words }) => ({ name, now, next, words })),
        hiddenCount: Math.max(0, rows.length - MAX_ROWS_SHOWN),
        limits: { min: rules.minWords, max: rules.maxWords },
        note: short.length > 0
          ? `Under the school's minimum of ${rules.minWords} words: ${short.join(', ')}. They save, and count as not finished.`
          : 'The learning skills stay as they are. Undo puts back the comments that were there.',
      },
    };
  },
});
