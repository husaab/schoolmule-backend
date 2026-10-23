// Reply reminders: the school-day ladder and the emails' wording. The sweep
// and the send-time checks run against Postgres in
// __tests__/integration/routes/replyReminders.routes.test.js. Synthetic names only.

const { dueStep, nudgeDue, schoolDaysSince } = require('../../../services/replyReminders');
const { teacherReminderEmail, officeEmail, parentNudgeEmail } = require('../../../templates/replyReminderEmails');

// Two school weeks, Mon Mar 2 to Fri Mar 13, 2026 (no weekend days).
const DAYS = ['02', '03', '04', '05', '06', '09', '10', '11', '12', '13'].map((d) => `2026-03-${d}`);
const at = (today, state = {}) => dueStep({ step: 0, lastDay: null, startDay: '2026-03-04', today, days: DAYS, ...state });

describe('dueStep', () => {
  it('reminds 2 school days after the parent wrote, again 2 school days later, then tells the office the next day', () => {
    expect(at('2026-03-05')).toBeNull();
    expect(at('2026-03-06')).toBe(1);
    expect(at('2026-03-09', { step: 1, lastDay: '2026-03-06' })).toBeNull();
    expect(at('2026-03-10', { step: 1, lastDay: '2026-03-06' })).toBe(2);
    expect(at('2026-03-11', { step: 2, lastDay: '2026-03-10' })).toBe(3);
    expect(at('2026-03-12', { step: 3, lastDay: '2026-03-11' })).toBeNull();
  });

  it('counts only school days: a weekend or a closed day pushes the reminder back', () => {
    // Written Friday: Monday is school day 1, Tuesday day 2.
    expect(at('2026-03-09', { startDay: '2026-03-06' })).toBeNull();
    expect(at('2026-03-10', { startDay: '2026-03-06' })).toBe(1);
    // With Monday closed, Tuesday is only day 1.
    const closedMonday = DAYS.filter((d) => d !== '2026-03-09');
    expect(at('2026-03-10', { startDay: '2026-03-06', days: closedMonday })).toBeNull();
    expect(at('2026-03-11', { startDay: '2026-03-06', days: closedMonday })).toBe(1);
  });

  it('sends nothing on a day the school is closed, and never two steps in one day', () => {
    expect(at('2026-03-07')).toBeNull();
    expect(at('2026-03-06', { step: 1, lastDay: '2026-03-06' })).toBeNull();
  });

  it('starts a conversation that was already waiting at the first reminder, one step a day from there', () => {
    const old = { startDay: '2026-01-05' };
    expect(at('2026-03-04', old)).toBe(1);
    expect(at('2026-03-05', { ...old, step: 1, lastDay: '2026-03-04' })).toBeNull();
  });
});

describe('nudgeDue', () => {
  it('is due 2 school days after the teacher wrote, on school days only', () => {
    expect(nudgeDue({ startDay: '2026-03-02', today: '2026-03-03', days: DAYS })).toBe(false);
    expect(nudgeDue({ startDay: '2026-03-02', today: '2026-03-04', days: DAYS })).toBe(true);
    expect(nudgeDue({ startDay: '2026-03-02', today: '2026-03-07', days: DAYS })).toBe(false);
  });

  it('schoolDaysSince counts the days after the start, up to and including today', () => {
    expect(schoolDaysSince('2026-03-06', '2026-03-10', DAYS)).toBe(2);
  });
});

const message = (over = {}) => ({
  senderLabel: 'Rania Test (Mother)',
  sentAtLabel: 'Wed, Oct 21, 5:18 p.m.',
  body: 'Amina was home sick on Thursday.\nCan she make it up? <script>',
  fileNames: ['doctors-note.pdf'],
  ...over,
});
const thread = (over = {}) => ({
  kind: 'assessment',
  title: 'Handwriting 2',
  studentName: 'Amina Test',
  studentGrade: 'Grade 4',
  classSubject: 'Arabic',
  fromLabel: 'Rania Test (Mother)',
  parentName: 'Rania Test',
  wroteLabel: 'Wed, Oct 21',
  step: 1,
  messages: [message({ senderLabel: 'Rania Test (Mother)', body: 'Salam,', fileNames: [] }), message()],
  link: 'https://app.example.com/messages?thread=t1',
  ...over,
});
const school = { schoolName: 'Test Academy', schoolInfo: null };

describe('teacherReminderEmail', () => {
  it('carries every message in full, escaped, with its sender and attachments', () => {
    const { subject, html } = teacherReminderEmail({ firstName: 'Doha', threads: [thread()], link: 'x', ...school });
    expect(subject).toBe('A parent is waiting to hear from you: Amina Test (Arabic)');
    expect(html).toContain('Hi Doha,');
    expect(html).toContain('Salam,');
    expect(html).toContain('Amina was home sick on Thursday.<br>Can she make it up? &lt;script&gt;');
    expect(html).toContain('Rania Test (Mother) · Wed, Oct 21, 5:18 p.m.');
    expect(html).toContain('doctors-note.pdf');
    expect(html).toContain('https://app.example.com/messages?thread=t1');
    expect(html).not.toContain('This is the last reminder');
  });

  it('says the second reminder is the last one before the office is told', () => {
    const { subject, html } = teacherReminderEmail({ firstName: 'Doha', threads: [thread({ step: 2 })], link: 'x', ...school });
    expect(subject).toBe('Last reminder: a parent is waiting for your reply (Amina Test)');
    expect(html).toContain('This is the last reminder');
  });

  it('lists several conversations in one email', () => {
    const other = thread({ kind: 'general', title: 'Field trip', studentName: 'Yusuf Test', classSubject: 'Homeroom', messages: [message({ body: 'Is the trip still on?' })] });
    const { subject, html } = teacherReminderEmail({ firstName: 'Doha', threads: [thread(), other], link: 'https://app.example.com/messages?view=needsReply', ...school });
    expect(subject).toBe('2 parent messages are waiting for your reply');
    expect(html).toContain('Is the trip still on?');
    expect(html).toContain('Yusuf Test: <strong');
    expect(html).toContain('messages?view=needsReply');
  });
});

describe('officeEmail', () => {
  it('names who was reminded and carries the parent message', () => {
    const t = thread({ teacherNames: 'Ms. Doha Teacher', teacherCount: 1, reminders: 2, remindedLabel: 'Fri, Oct 23 and Tue, Oct 27' });
    const { subject, html } = officeEmail({ threads: [t], link: 'x', ...school });
    expect(subject).toBe("No reply yet: Rania Test's message about Amina Test");
    expect(html).toContain("Ms. Doha Teacher was reminded twice and hasn't replied.");
    expect(html).toContain('Fri, Oct 23 and Tue, Oct 27');
    expect(html).toContain('Salam,');
    expect(html).toContain('you can see all messages at Test Academy');
  });

  it('says so when there was no teacher to remind', () => {
    const { html } = officeEmail({ threads: [thread({ unreachable: true, teacherNames: '', teacherCount: 0, reminders: 0 })], link: 'x', ...school });
    expect(html).toContain("There's no teacher with an email address to remind");
  });
});

describe('parentNudgeEmail', () => {
  it('shows the teacher message in full and says it is a one-time reminder', () => {
    const t = thread({ fromLabel: 'Ms. Sara Teacher', messages: [message({ senderLabel: 'Ms. Sara Teacher', body: 'Could Yusuf hand in the lab report by Wednesday?', fileNames: [] })], studentName: 'Yusuf Test' });
    const { subject, html } = parentNudgeEmail({ firstName: 'Huda', threads: [t], link: 'https://app.example.com/email-login?next=x#token', ...school });
    expect(subject).toBe('Ms. Sara Teacher sent you a message about Yusuf Test');
    expect(html).toContain('Could Yusuf hand in the lab report by Wednesday?');
    expect(html).toContain('https://app.example.com/email-login?next=x#token');
    expect(html).toContain('one-time reminder');
  });
});
