// studentWork's pure read-model selectors: what the home page, the class
// cards and Coming up, the Stream notices and the parent's "Needs you" take
// from one student's work items (statuses already decided by the one rule).

const {
  upcomingOf, classSummaries, dueWithin, dueSoonOf, missingOf, homeMissingOf, noticesOf, needsYouMissing, parseTextAnswer,
} = require('../../../services/classroom/studentWork');

// Friday 2026-10-16, 10:00 in Toronto.
const NOW = new Date('2026-10-16T14:00:00Z');
const HOUR = 60 * 60 * 1000;
const at = (h) => new Date(NOW.getTime() + h * HOUR).toISOString();

let n = 0;
const w = (extra) => ({
  itemId: `i${++n}`, classId: 'sci', subject: 'Science', teacherName: 'Ziad Teacher', iconUrl: '/class-icons/science.svg',
  title: `Item ${n}`, kind: 'assignment', submissionMode: 'file', dueAt: null, date: null, status: 'assigned', isLate: false,
  questionCount: 0, turnedInAt: null, publishedAt: null, topicId: null, postedAt: null, grade: null, assessmentId: null,
  teacher: { userId: 'u1', name: 'Ziad Teacher', avatar: null }, ...extra,
});
const titles = (list) => list.map((i) => i.title);

describe('upcomingOf and classSummaries', () => {
  it('lists what is still ahead from today on, soonest first, at most 3; a dated test counts, done work does not', () => {
    const work = [
      w({ title: 'Next week', dueAt: at(24 * 6) }),
      w({ title: 'Turned in', status: 'turned_in', dueAt: at(2) }),
      w({ title: 'Unit test', kind: 'assessment', submissionMode: 'none', status: 'no_turn_in', date: '2026-10-17' }),
      w({ title: 'Tonight', dueAt: at(9) }),
      w({ title: 'Yesterday test', kind: 'assessment', submissionMode: 'none', status: 'no_turn_in', date: '2026-10-15' }),
      w({ title: 'Reading', kind: 'material', submissionMode: 'none', status: 'material', date: '2026-10-16' }),
      w({ title: 'Undated', dueAt: null }),
      w({ title: 'Later', dueAt: at(24 * 9) }),
    ];
    expect(titles(upcomingOf(work, NOW))).toEqual(['Tonight', 'Unit test', 'Next week']);
    expect(Object.keys(upcomingOf(work, NOW)[0])).not.toContain('teacher');
  });

  it("gives each class its next item and missing count", () => {
    const work = [
      w({ title: 'Lab', dueAt: at(30) }),
      w({ title: 'Late lab', status: 'missing', dueAt: at(-30) }),
      w({ title: 'Paper test missing', kind: 'assessment', status: 'missing', date: '2026-10-10' }),
      w({ classId: 'math', title: 'Done', status: 'graded', dueAt: at(5) }),
    ];
    const s = classSummaries(work, NOW);
    expect(s.get('sci')).toEqual({ next: { itemId: work[0].itemId, title: 'Lab', kind: 'assignment', dueAt: work[0].dueAt, date: null }, missingCount: 2 });
    expect(s.get('math')).toEqual({ next: null, missingCount: 0 });
  });
});

describe('due soon and missing', () => {
  it('due soon is assigned work due within 7 days, soonest first, at most 5', () => {
    const work = [
      ...[1, 2, 3, 4, 5, 6].map((d) => w({ title: `Day ${d}`, dueAt: at(24 * d) })),
      w({ title: 'Eight days', dueAt: at(24 * 8) }),
      w({ title: 'Turned in', status: 'turned_in', dueAt: at(5) }),
      w({ title: 'No date' }),
    ];
    expect(titles(dueSoonOf(work, NOW))).toEqual(['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5']);
    expect(dueWithin(work, NOW)).toHaveLength(6);
  });

  it('missing is newest due first; home keeps 3', () => {
    const work = [
      w({ title: 'Oct 9', status: 'missing', dueAt: '2026-10-09T19:30:00Z' }),
      w({ title: 'Oct 15', status: 'missing', dueAt: '2026-10-15T19:30:00Z' }),
      w({ title: 'Oct 12 test', kind: 'assessment', status: 'missing', date: '2026-10-12' }),
      w({ title: 'Oct 1', status: 'missing', dueAt: '2026-10-01T19:30:00Z' }),
      w({ title: 'Assigned', dueAt: at(5) }),
    ];
    expect(titles(missingOf(work))).toEqual(['Oct 15', 'Oct 12 test', 'Oct 9', 'Oct 1']);
    expect(titles(homeMissingOf(work))).toEqual(['Oct 15', 'Oct 12 test', 'Oct 9']);
  });
});

describe('noticesOf', () => {
  it('posted assignments, quizzes and materials, newest first, as Notice', () => {
    const work = [
      w({ title: 'Old', postedAt: '2026-10-01T12:00:00.000Z', dueAt: at(5) }),
      w({ title: 'Test', kind: 'assessment', postedAt: '2026-10-15T12:00:00.000Z' }),
      w({ title: 'Reading', kind: 'material', postedAt: '2026-10-14T12:00:00.000Z' }),
      w({ title: 'Quiz', kind: 'quiz', postedAt: '2026-10-12T12:00:00.000Z' }),
    ];
    expect(noticesOf(work)).toEqual([
      { itemId: work[2].itemId, kind: 'material', title: 'Reading', postedAt: '2026-10-14T12:00:00.000Z', dueAt: null },
      { itemId: work[3].itemId, kind: 'quiz', title: 'Quiz', postedAt: '2026-10-12T12:00:00.000Z', dueAt: null },
      { itemId: work[0].itemId, kind: 'assignment', title: 'Old', postedAt: '2026-10-01T12:00:00.000Z', dueAt: work[0].dueAt },
    ]);
  });
});

describe('needsYouMissing', () => {
  it('missing work due within the last 14 days, newest due first, with the teacher to ask', () => {
    const work = [
      w({ title: 'Two days ago', status: 'missing', dueAt: at(-48), assessmentId: 'a1' }),
      w({ title: 'Fifteen days ago', status: 'missing', dueAt: at(-24 * 15) }),
      w({ title: 'Dated test', kind: 'assessment', status: 'missing', date: '2026-10-10' }),
      w({ title: 'Old test', kind: 'assessment', status: 'missing', date: '2026-09-20' }),
      w({ title: 'Undated', kind: 'assessment', status: 'missing' }),
      w({ title: 'Marked early', status: 'missing', dueAt: at(48) }),
      w({ title: 'Assigned', dueAt: at(-48) }),
    ];
    expect(needsYouMissing(work, 'stu-1', NOW)).toEqual([
      {
        kind: 'missing', itemId: work[0].itemId, assessmentId: 'a1', title: 'Two days ago', classId: 'sci', classSubject: 'Science',
        teacher: { userId: 'u1', name: 'Ziad Teacher', avatar: null }, studentId: 'stu-1', dueAt: work[0].dueAt, date: null,
      },
      expect.objectContaining({ title: 'Dated test', dueAt: null, date: '2026-10-10' }),
    ]);
  });
});

describe('parseTextAnswer', () => {
  it('keeps text as typed, empty clears, and refuses non-text or over 20 000 characters', () => {
    expect(parseTextAnswer('  my answer ')).toEqual({ value: '  my answer ' });
    expect(parseTextAnswer('')).toEqual({ value: null });
    expect(parseTextAnswer(null)).toEqual({ value: null });
    expect(parseTextAnswer('x'.repeat(20000))).toEqual({ value: 'x'.repeat(20000) });
    expect(parseTextAnswer('x'.repeat(20001)).error).toMatch(/20,000/);
    expect(parseTextAnswer(42).error).toBe('Your answer must be text.');
  });
});
