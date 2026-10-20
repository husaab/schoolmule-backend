// The classroom email digests' pure rules: Toronto clock gates (DST
// included), digest keys, the subjects and labels the P3 board shows, and
// which work rows land in which section. Synthetic names only.

const d = require('../../../services/classroom/classroomDigest');

const at = (iso) => new Date(iso);

describe('torontoParts', () => {
  it('reads the date, hour and weekday in Toronto, across midnight and DST', () => {
    // 16:00 EDT on Friday Oct 16, 2026 (UTC-4).
    expect(d.torontoParts(at('2026-10-16T20:00:00Z'))).toEqual({ date: '2026-10-16', hour: 16, dow: 5 });
    // 23:30 Toronto is still Friday although UTC is Saturday.
    expect(d.torontoParts(at('2026-10-17T03:30:00Z'))).toEqual({ date: '2026-10-16', hour: 23, dow: 5 });
    // After DST ends (Nov 1, 2026) Toronto is UTC-5: 21:00Z is 16:00.
    expect(d.torontoParts(at('2026-11-06T21:00:00Z'))).toEqual({ date: '2026-11-06', hour: 16, dow: 5 });
    expect(d.torontoParts(at('2026-11-06T20:59:00Z')).hour).toBe(15);
    // Midnight reads as hour 0, not 24.
    expect(d.torontoParts(at('2026-10-19T04:00:00Z'))).toEqual({ date: '2026-10-19', hour: 0, dow: 1 });
  });
});

describe('torontoInstant and sweepWindows', () => {
  it('finds the instant of a Toronto wall-clock hour, across DST', () => {
    expect(d.torontoInstant('2026-10-16', 16).toISOString()).toBe('2026-10-16T20:00:00.000Z'); // EDT
    expect(d.torontoInstant('2026-11-06', 16).toISOString()).toBe('2026-11-06T21:00:00.000Z'); // EST
    expect(d.torontoInstant('2026-11-01', 16).toISOString()).toBe('2026-11-01T21:00:00.000Z'); // the day DST ends
    expect(d.torontoInstant('2026-03-08', 16).toISOString()).toBe('2026-03-08T20:00:00.000Z'); // the day DST starts
  });

  it('anchors the sweeps to 4 pm, so a later run the same day reads the same windows', () => {
    const at430 = d.sweepWindows(at('2030-10-18T20:30:00Z'));
    const at1800 = d.sweepWindows(at('2030-10-18T22:00:00Z'));
    expect(at1800).toEqual(at430);
    expect(at430.until.toISOString()).toBe('2030-10-18T20:00:00.000Z');
    expect(at430.day.toISOString()).toBe('2030-10-17T20:00:00.000Z');
    expect(at430.week.toISOString()).toBe('2030-10-11T20:00:00.000Z');
    // Across the fall DST change the week still runs 4 pm to 4 pm.
    expect(d.sweepWindows(at('2026-11-06T21:30:00Z')).week.toISOString()).toBe('2026-10-30T20:00:00.000Z');
  });
});

describe('scheduleGates', () => {
  it('opens due reminders at 17:00 and missing alerts and summaries at 16:00, Toronto time', () => {
    expect(d.scheduleGates(at('2026-10-16T19:59:00Z'))).toEqual({
      dueReminder: false, missingAlert: false, dailySummary: false, weeklySummary: false,
    });
    expect(d.scheduleGates(at('2026-10-16T20:00:00Z'))).toEqual({
      dueReminder: false, missingAlert: true, dailySummary: true, weeklySummary: true, // Friday is the default day
    });
    expect(d.scheduleGates(at('2026-10-16T21:00:00Z'))).toMatchObject({ dueReminder: true, missingAlert: true });
  });

  it('keeps the same Toronto hours after DST ends', () => {
    // Friday Nov 6, 2026: 20:30Z is 15:30 EST, so nothing is open yet.
    expect(d.scheduleGates(at('2026-11-06T20:30:00Z'))).toMatchObject({ missingAlert: false, weeklySummary: false });
    expect(d.scheduleGates(at('2026-11-06T21:00:00Z'))).toMatchObject({ missingAlert: true, weeklySummary: true, dueReminder: false });
    expect(d.scheduleGates(at('2026-11-06T22:00:00Z'))).toMatchObject({ dueReminder: true });
  });

  it("sends the weekly summary on the recipient's day: their own pick, else the school's", () => {
    const thursday4pm = at('2026-10-15T20:30:00Z');
    expect(d.scheduleGates(thursday4pm, { schoolDow: 5 }).weeklySummary).toBe(false);
    expect(d.scheduleGates(thursday4pm, { schoolDow: 4 }).weeklySummary).toBe(true);
    expect(d.scheduleGates(thursday4pm, { schoolDow: 5, prefsDow: 4 }).weeklySummary).toBe(true);
    expect(d.scheduleGates(thursday4pm, { schoolDow: 4, prefsDow: 1 }).weeklySummary).toBe(false);
    expect(d.scheduleGates(thursday4pm, { schoolDow: 4, prefsDow: null }).weeklySummary).toBe(true);
    // A daily summary goes every day from 16:00.
    expect(d.scheduleGates(thursday4pm, { schoolDow: 5 }).dailySummary).toBe(true);
  });
});

describe('isoWeekKey', () => {
  it('names the ISO week of the Toronto date, across a year boundary', () => {
    expect(d.isoWeekKey(at('2026-10-16T20:00:00Z'))).toBe('2026-W42');
    // Jan 1, 2027 is a Friday: it belongs to 2026's 53rd week.
    expect(d.isoWeekKey(at('2027-01-01T21:00:00Z'))).toBe('2026-W53');
    // Monday Dec 29, 2025 starts 2026-W01 (Jan 1, 2026 is a Thursday).
    expect(d.isoWeekKey(at('2025-12-29T17:00:00Z'))).toBe('2026-W01');
    expect(d.isoWeekKey(at('2027-01-04T17:00:00Z'))).toBe('2027-W01');
    // Sunday 23:30 Toronto is still the week that started on Monday.
    expect(d.isoWeekKey(at('2026-10-19T03:30:00Z'))).toBe('2026-W42');
  });
});

describe('gradedBucket', () => {
  it('cuts time into 15-minute buckets and keys them by their start', () => {
    const b = d.gradedBucket(at('2026-10-16T20:07:31.250Z'));
    expect(b.start.toISOString()).toBe('2026-10-16T20:00:00.000Z');
    expect(b.end.toISOString()).toBe('2026-10-16T20:15:00.000Z');
    expect(b.key).toBe('graded:2026-10-16T20:00:00.000Z');
    // Two moments in one bucket share it; the boundary starts the next one.
    expect(d.gradedBucket(at('2026-10-16T20:14:59.999Z')).key).toBe(b.key);
    expect(d.gradedBucket(at('2026-10-16T20:15:00.000Z')).key).toBe('graded:2026-10-16T20:15:00.000Z');
    expect(d.gradedBucket(at('2026-10-16T20:00:00.000Z')).key).toBe(b.key);
  });
});

describe('summarySubject', () => {
  it("matches the P3 board's subject: the first child 'has', children with nothing are left out", () => {
    // The board's fixture: the first child also has a post ("From the teachers"),
    // but a child's subject part keeps its two most pressing counts.
    const children = [
      { name: 'Yasmin', missing: 1, newGrades: 2, posts: 1 },
      { name: 'Omar', missing: 0, newGrades: 0, posts: 0 },
      { name: 'Lina', missing: 0, newGrades: 0, posts: 2 },
    ];
    expect(d.summarySubject(children)).toBe('Weekly Summary: Yasmin has 1 missing, 2 new grades · Lina: 2 posts');
  });

  it('counts in the singular and the plural, at most two counts per child', () => {
    expect(d.summarySubject([{ name: 'Yasmin', missing: 2, newGrades: 1, posts: 1 }]))
      .toBe('Weekly Summary: Yasmin has 2 missing, 1 new grade');
    expect(d.summarySubject([{ name: 'Yasmin', newGrades: 1, posts: 1 }]))
      .toBe('Weekly Summary: Yasmin has 1 new grade, 1 post');
    expect(d.summarySubject([{ name: 'Omar', missing: 0, newGrades: 0, posts: 0 }, { name: 'Lina', newGrades: 3 }]))
      .toBe('Weekly Summary: Lina has 3 new grades');
  });

  it("names the day for a daily summary and falls back to the period's label", () => {
    expect(d.summarySubject([{ name: 'Lina', posts: 1 }], { period: 'day' })).toBe('Daily Summary: Lina has 1 post');
    expect(d.summarySubject([{ name: 'Lina' }], { label: 'Oct 12–16' })).toBe('Weekly Summary: Oct 12–16');
  });
});

describe('missingSubject', () => {
  it('lists each child with a count', () => {
    expect(d.missingSubject([{ name: 'Yasmin', count: 1 }, { name: 'Lina', count: 2 }])).toBe('Missing work: Yasmin (1), Lina (2)');
    expect(d.missingSubject([{ name: 'Yasmin', items: [{}, {}] }, { name: 'Omar', count: 0 }])).toBe('Missing work: Yasmin (2)');
  });
});

describe('weekLabel and summaryRange', () => {
  it('shortens the range like the board', () => {
    expect(d.weekLabel('2026-10-12', '2026-10-16')).toBe('Oct 12–16');
    expect(d.weekLabel('2026-10-29', '2026-11-02')).toBe('Oct 29–Nov 2');
    expect(d.weekLabel('2026-12-28', '2027-01-01')).toBe('Dec 28–Jan 1');
    expect(d.weekLabel('2026-10-16', '2026-10-16')).toBe('Oct 16');
  });

  it("covers the school week up to the summary's day (a leading weekend is skipped)", () => {
    expect(d.summaryRange(at('2026-10-16T20:00:00Z'))).toEqual({ from: '2026-10-12', to: '2026-10-16' }); // Friday
    expect(d.summaryRange(at('2026-10-14T20:00:00Z'))).toEqual({ from: '2026-10-08', to: '2026-10-14' }); // Wednesday
    expect(d.summaryRange(at('2026-10-18T20:00:00Z'))).toEqual({ from: '2026-10-12', to: '2026-10-18' }); // Sunday
  });
});

describe('labels', () => {
  it('formats days, grades, names and scores', () => {
    expect(d.dayLabel(at('2026-10-14T03:59:00Z'))).toBe('Tue, Oct 13'); // 23:59 Toronto on the 13th
    expect(d.dayLabel('2026-10-13')).toBe('Tue, Oct 13');
    expect(d.weekdayShort(at('2026-10-19T15:00:00Z'))).toBe('Mon');
    expect(d.timeLabel(at('2026-10-20T03:59:00Z'))).toBe('11:59 PM');
    expect(d.gradeLabel('5')).toBe('Grade 5');
    expect(d.gradeLabel('SK')).toBe('SK');
    expect(d.firstName('  Yasmin  Haddad ')).toBe('Yasmin');
    expect(d.possessiveNames(['Yasmin'])).toBe("Yasmin's");
    expect(d.possessiveNames(['Yasmin', 'Lina'])).toBe("Yasmin's and Lina's");
    expect(d.possessiveNames(['Yasmin', 'Omar', 'Lina'])).toBe("Yasmin's, Omar's and Lina's");
    expect(d.dowPlural(5)).toBe('Fridays');
    expect(d.dowPlural(0)).toBe('Sundays');
    expect(d.scoreLabel({ score: '8.00', maxScore: '10.00', status: 'graded' })).toBe('8/10');
    expect(d.scoreLabel({ score: 7.5, maxScore: 10 })).toBe('7.5/10');
    expect(d.scoreLabel({ score: 9, maxScore: null })).toBe('9');
    expect(d.scoreLabel({ score: null, maxScore: 10, status: 'excused' })).toBe('Excused');
    expect(d.scoreLabel({ score: null, maxScore: 10, status: 'graded' })).toBeNull();
    expect(d.excerpt('  one\n\ntwo  ', 50)).toBe('one two');
    expect(d.excerpt('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(d.excerptLines('Label six parts.  \r\n\r\n\r\n\nUse colour.\n')).toBe('Label six parts.\n\nUse colour.');
    expect(d.excerptLines('y'.repeat(700), 600)).toHaveLength(600);
  });
});

describe('sections', () => {
  const now = at('2026-10-16T20:30:00Z'); // Friday 16:30 Toronto
  const HOUR = 60 * 60 * 1000;
  const ago = (h) => new Date(now.getTime() - h * HOUR);
  const row = (o) => ({
    student_id: 's1', item_id: o.item_id, kind: 'assignment', assessment_id: 'a1', title: o.item_id, subject: 'Science',
    class_grade: '5', due_at: null, date: null, state: 'assigned', grade_visible: false, score: null, status: null,
    max_score: 10, grade_published_at: null, feedback: null, feedback_published_at: null, teacher_name: 'Ziad Teacher', ...o,
  });

  it('stillMissing: what is still missing now, newest due first', () => {
    const rows = [
      row({ item_id: 'older', state: 'missing', due_at: ago(30) }),
      row({ item_id: 'newer', state: 'missing', due_at: ago(3) }),
      row({ item_id: 'turned-in-since', state: 'turned_in', due_at: ago(3) }),
      row({ item_id: 'graded-since', state: 'graded', grade_visible: true, score: '0' }),
    ];
    expect(d.stillMissing(rows).map((r) => r.item_id)).toEqual(['newer', 'older']);
  });

  it('summarySections: Missing (last 14 days), new grades and feedback in the window, due next week', () => {
    const rows = [
      row({ item_id: 'missing-recent', state: 'missing', due_at: ago(48) }),
      row({ item_id: 'missing-ancient', state: 'missing', due_at: ago(24 * 20) }),
      row({ item_id: 'missing-dated', kind: 'assessment', state: 'missing', grade_visible: true, status: 'missing', date: '2026-10-13', grade_published_at: ago(24 * 9) }),
      row({ item_id: 'graded-new', state: 'graded', grade_visible: true, score: '8', status: 'graded', grade_published_at: ago(5), feedback: 'Good work.', feedback_published_at: ago(5) }),
      row({ item_id: 'graded-old', state: 'graded', grade_visible: true, score: '6', status: 'graded', grade_published_at: ago(24 * 8) }),
      row({ item_id: 'excused-new', state: 'excused', grade_visible: true, status: 'excused', grade_published_at: ago(5) }),
      row({ item_id: 'feedback-only', assessment_id: null, state: 'turned_in', feedback: 'Neat.', feedback_published_at: ago(1) }),
      row({ item_id: 'kinder-grade', class_grade: 'SK', state: 'graded', grade_visible: true, score: '3', grade_published_at: ago(5) }),
      row({ item_id: 'due-monday', due_at: at('2026-10-19T15:00:00Z') }),
      row({ item_id: 'due-friday-next', due_at: at('2026-10-23T15:00:00Z') }),
      row({ item_id: 'due-too-far', due_at: at('2026-10-24T15:00:00Z') }),
      row({ item_id: 'due-tonight', due_at: at('2026-10-17T03:00:00Z') }),
      row({ item_id: 'due-turned-in', state: 'turned_in', due_at: at('2026-10-19T15:00:00Z') }),
    ];
    const weekly = d.summarySections(rows, { since: ago(24 * 7), until: now, now, frequency: 'weekly' });
    expect(weekly.missing.map((r) => r.item_id)).toEqual(['missing-recent', 'missing-dated']);
    expect(weekly.grades.map((r) => r.item_id).sort()).toEqual(['excused-new', 'feedback-only', 'graded-new']);
    // Still to come and not turned in: from now (tonight included) to a week from today.
    expect(weekly.due.map((r) => r.item_id)).toEqual(['due-tonight', 'due-monday', 'due-friday-next']);

    // Daily: the last day's grades, and only what is due by the end of tomorrow (Saturday here).
    const daily = d.summarySections([...rows, row({ item_id: 'due-saturday', due_at: at('2026-10-17T15:00:00Z') })],
      { since: ago(24), now, frequency: 'daily' });
    expect(daily.grades.map((r) => r.item_id).sort()).toEqual(['excused-new', 'feedback-only', 'graded-new']);
    expect(daily.due.map((r) => r.item_id)).toEqual(['due-tonight', 'due-saturday']);

    // A grade published after the window's end belongs to the next summary.
    const ended = d.summarySections(rows, { since: ago(24), until: ago(6), now, frequency: 'daily' });
    expect(ended.grades).toEqual([]);
  });
});
