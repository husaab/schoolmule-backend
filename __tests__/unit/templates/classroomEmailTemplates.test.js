// The classroom emails' words: each template's subject and the blocks the
// P3 board (weekly summary) and spec §7 ask for. Synthetic names only.

const t = require('../../../templates/classroomEmailTemplates');

const school = { schoolName: 'Al Haadi Academy', schoolInfo: { school_code: 'ALHAADIACADEMY', name: 'Al Haadi Academy' } };
// The email as a reader sees it: tags dropped, entities decoded, spaces collapsed.
const text = (html) => html
  .replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<\/?(a|strong|em|b|span)\b[^>]*>/g, '') // inline tags join their neighbours
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const noReturnWord = (html) => expect(text(html)).not.toMatch(/\breturn/i);

describe('newWorkEmail', () => {
  const base = {
    ...school,
    recipientFirstName: 'Yasmin',
    kind: 'assignment',
    title: 'Plant cell diagram',
    subject: 'Science',
    teacherName: 'Ziad Teacher',
    teacherAvatarUrl: 'https://schoolmule.ca/email/avatars/neutral.png',
    dueLabel: 'Tue, Oct 20 at 11:59 PM',
    points: 10,
    instructions: 'Label <six> parts.\nUse colour.',
    link: 'http://localhost:3000/student/items/item-1',
  };

  it('names the work, the class, the teacher and the due date, with one button to the item', () => {
    const { subject, html } = t.newWorkEmail(base);
    expect(subject).toBe('New assignment in Science: Plant cell diagram');
    const body = text(html);
    expect(body).toContain('Hi Yasmin,');
    expect(body).toContain('Ziad Teacher posted a new assignment in Science.');
    expect(body).toContain('Due Tue, Oct 20 at 11:59 PM');
    expect(body).toContain('Points 10');
    expect(body).toContain('Label <six> parts.');
    expect(html).toContain('Label &lt;six&gt; parts.<br>Use colour.');
    expect(body).toContain('Open in SchoolMule');
    expect(html).toContain('href="http://localhost:3000/student/items/item-1"');
    expect(html).toContain('https://schoolmule.ca/email/avatars/neutral.png');
    expect(body).toContain('Al Haadi Academy');
    noReturnWord(html);
  });

  it('words each kind and leaves out what the item does not have', () => {
    expect(t.newWorkEmail({ ...base, kind: 'quiz' }).subject).toBe('New quiz in Science: Plant cell diagram');
    expect(t.newWorkEmail({ ...base, kind: 'assessment' }).subject).toBe('New assessment in Science: Plant cell diagram');
    const material = t.newWorkEmail({ ...base, kind: 'material', title: 'Cells reading', dueLabel: null, points: null, instructions: null });
    expect(material.subject).toBe('New material in Science: Cells reading');
    expect(text(material.html)).toContain('Ziad Teacher posted new material in Science.');
    expect(text(material.html)).not.toContain('Due');
    expect(text(material.html)).not.toContain('Points');
  });
});

describe('dueReminderEmail', () => {
  const item = (title, subject = 'Science') => ({ title, subject, dueLabel: '11:59 PM' });

  it('one item: names it in the subject and links to it', () => {
    const { subject, html } = t.dueReminderEmail({
      ...school, recipientFirstName: 'Yasmin', items: [item('Plant cell diagram')], link: 'http://localhost:3000/student/items/i1',
    });
    expect(subject).toBe('Due tomorrow: Plant cell diagram');
    expect(text(html)).toContain("Plant cell diagram · Science · due 11:59 PM");
    expect(text(html)).toContain("isn't turned in yet");
    expect(html).toContain('href="http://localhost:3000/student/items/i1"');
    noReturnWord(html);
  });

  it('several items: counts the rest', () => {
    const { subject, html } = t.dueReminderEmail({
      ...school, recipientFirstName: 'Yasmin', items: [item('Plant cell diagram'), item('Fractions practice', 'Math')], link: 'x',
    });
    expect(subject).toBe('Due tomorrow: Plant cell diagram and 1 more');
    expect(text(html)).toContain('Fractions practice · Math · due 11:59 PM');
  });
});

describe('gradedEmail', () => {
  const grade = (title, o = {}) => ({ title, subject: 'Science', scoreLabel: '8/10', feedback: 'Great labels.', teacherName: 'Ziad Teacher', ...o });

  it('lists each grade with its score, feedback and teacher', () => {
    const { subject, html } = t.gradedEmail({
      ...school, recipientFirstName: 'Yasmin',
      grades: [grade('Plant cell diagram'), grade('Fractions practice', { subject: 'Math', scoreLabel: '9/10', feedback: null })],
      link: 'http://localhost:3000/student/grades',
    });
    expect(subject).toBe('Graded: Plant cell diagram and 1 more');
    const body = text(html);
    expect(body).toContain('Plant cell diagram · Science 8/10');
    expect(body).toContain('"Great labels." Ziad Teacher');
    expect(body).toContain('Fractions practice · Math 9/10');
    expect(html).toContain('href="http://localhost:3000/student/grades"');
    noReturnWord(html);
    expect(t.gradedEmail({ ...school, recipientFirstName: 'Yasmin', grades: [grade('Plant cell diagram')], link: 'x' }).subject)
      .toBe('Graded: Plant cell diagram');
  });
});

describe('missingAlertEmail', () => {
  it('one email for the family, a block per child', () => {
    const { subject, html } = t.missingAlertEmail({
      ...school,
      recipientFirstName: 'Mona',
      children: [
        { name: 'Yasmin', gradeLabel: 'Grade 5', avatarUrl: null, items: [{ title: 'Spelling list 4', subject: 'English', whenLabel: 'was due Tue, Oct 13' }] },
        { name: 'Lina', gradeLabel: 'Grade 3', avatarUrl: null, items: [
          { title: 'Number line', subject: 'Math', whenLabel: 'was due Thu, Oct 15' },
          { title: 'Map quiz', subject: 'Social Studies', whenLabel: null },
        ] },
      ],
      link: 'http://localhost:3000/parent/classes',
      prefsLink: 'http://localhost:3000/parent/notifications',
    });
    expect(subject).toBe('Missing work: Yasmin (1), Lina (2)');
    const body = text(html);
    expect(body).toContain('Yasmin · Grade 5');
    expect(body).toContain('Spelling list 4 · English · was due Tue, Oct 13');
    expect(body).toContain('Lina · Grade 3');
    expect(body).toContain('Map quiz · Social Studies');
    expect(body).toContain('Open SchoolMule');
    expect(html).toContain('href="http://localhost:3000/parent/notifications"');
    noReturnWord(html);
  });
});

describe('weeklySummaryEmail', () => {
  const children = [
    {
      name: 'Yasmin', gradeLabel: 'Grade 5', avatarUrl: 'https://schoolmule.ca/email/avatars/hijab-1-2.png',
      missing: [{ title: 'Spelling list 4', subject: 'English', whenLabel: 'was due Tue, Oct 13' }],
      grades: [
        { title: 'Plant cell diagram', subject: 'Science', scoreLabel: '8/10', feedback: 'Great labels and a clear drawing.', teacherName: 'Ziad Teacher' },
        { title: 'Fractions practice', subject: 'Math', scoreLabel: '9/10', feedback: 'Show your steps on question 6.', teacherName: 'Dina Teacher' },
      ],
      due: [{ title: 'Decimals worksheet', subject: 'Math', dayLabel: 'Mon' }],
      posts: [{ title: 'Science Centre trip', authorName: 'Ziad Teacher', note: 'please sign by Monday', ackLink: 'http://localhost:3000/parent/messages?tab=announcements&announcement=a1&ack=1' }],
    },
    {
      name: 'Lina', gradeLabel: 'SK', avatarUrl: null, missing: [], grades: [], due: [],
      posts: [
        { title: 'Pumpkin patch photos', authorName: 'Hala Teacher', note: 'from our trip', ackLink: null },
        { title: 'Letter of the week: P', authorName: 'Hala Teacher', note: 'bring something for show and tell', ackLink: null },
      ],
    },
  ];
  const base = {
    ...school,
    recipientFirstName: 'Mona',
    frequency: 'weekly',
    dayName: 'Fridays',
    rangeLabel: 'Oct 12–16',
    children,
    link: 'http://localhost:3000/parent/classes',
    dailyLink: 'http://localhost:3000/parent/notifications?set=daily',
    offLink: 'http://localhost:3000/parent/notifications?set=off',
    prefsLink: 'http://localhost:3000/parent/notifications',
  };

  it("is the P3 board: subject, heading, intro, every section and the footer's two links", () => {
    const { subject, html } = t.weeklySummaryEmail(base);
    expect(subject).toBe('Weekly Summary: Yasmin has 1 missing, 2 new grades · Lina: 2 posts');
    const body = text(html);
    expect(body).toContain('Weekly Summary: Oct 12–16');
    expect(body).toContain("Here's what happened in Yasmin's and Lina's classes this week.");
    expect(body).toContain('Yasmin · Grade 5');
    expect(body).toContain('Lina · SK');
    for (const heading of ['Missing', 'New grades & feedback', 'Due next week', 'From the teachers']) expect(body).toContain(heading);
    expect(body).toContain('Spelling list 4 · English · was due Tue, Oct 13');
    expect(body).toContain('Science 1 new grade Plant cell diagram "Great labels and a clear drawing." Ziad Teacher 8/10');
    expect(body).toContain('"Great labels and a clear drawing." Ziad Teacher');
    expect(body).toContain('Decimals worksheet · Math Mon');
    expect(body).toContain('Science Centre trip Ziad Teacher · please sign by Monday');
    expect(body).toContain('Got it ✓');
    expect(html).toContain('href="http://localhost:3000/parent/messages?tab=announcements&amp;announcement=a1&amp;ack=1"');
    expect(body).toContain('Open SchoolMule');
    expect(html).toContain('href="http://localhost:3000/parent/classes"');
    expect(body).toContain('You get this summary on Fridays. Get it daily · Turn it off. Announcements always arrive right away.');
    expect(html).toContain('href="http://localhost:3000/parent/notifications?set=daily"');
    expect(html).toContain('href="http://localhost:3000/parent/notifications?set=off"');
    expect(html).toContain('https://schoolmule.ca/email/avatars/hijab-1-2.png');
    // A child's empty sections are left out: Lina has no Missing block of her own.
    expect(body.split('Lina · SK')[1]).not.toContain('Missing');
    noReturnWord(html);
  });

  it('a daily summary says so and offers the weekly one instead', () => {
    const { subject, html } = t.weeklySummaryEmail({ ...base, frequency: 'daily', rangeLabel: 'Fri, Oct 16' });
    expect(subject).toBe('Daily Summary: Yasmin has 1 missing, 2 new grades · Lina: 2 posts');
    const body = text(html);
    expect(body).toContain('Daily Summary: Fri, Oct 16');
    expect(body).toContain("Here's what happened in Yasmin's and Lina's classes today.");
    expect(body).toContain('Due soon');
    expect(body).toContain('You get this summary every day. Get it weekly · Turn it off. Announcements always arrive right away.');
    expect(html).not.toContain('set=daily');
  });

  it('without preference links (a staff account) it still says when it comes', () => {
    const { html } = t.weeklySummaryEmail({ ...base, dailyLink: null, offLink: null });
    expect(text(html)).toContain('You get this summary on Fridays. Announcements always arrive right away.');
    expect(html).not.toContain('set=off');
  });
  it('files the new grades under one card per subject, in name order, with the count and no repeated subject', () => {
    const { html } = t.weeklySummaryEmail({
      ...base,
      children: [{
        ...children[0],
        grades: [
          { title: 'Reading 1', subject: 'Arabic', scoreLabel: '4/5', feedback: null, teacherName: null },
          { title: 'Plant cell diagram', subject: 'Science', scoreLabel: '8/10', feedback: 'Great labels.', teacherName: 'Ziad Teacher' },
          { title: 'Hadith 1', subject: 'Arabic', scoreLabel: '5/5', feedback: null, teacherName: null },
        ],
      }],
    });
    const body = text(html);
    expect(body).toContain('Arabic 2 new grades Reading 1 4/5 Hadith 1 5/5');
    expect(body).toContain('Science 1 new grade Plant cell diagram "Great labels." Ziad Teacher 8/10');
    expect(body.indexOf('Arabic 2 new grades')).toBeLessThan(body.indexOf('Science 1 new grade'));
    expect(body).not.toContain('· Arabic');
    expect(body.match(/Arabic/g)).toHaveLength(1);
  });

  it('to a parent with no account: a link to set one up instead of the portal, and no way to turn it off', () => {
    const { html } = t.weeklySummaryEmail({
      ...base, recipientFirstName: null, dailyLink: null, offLink: null, prefsLink: null,
      setupLink: 'http://localhost:3000/signup/alhaadiacademy/parent',
    });
    const body = text(html);
    expect(body).toContain('Hi there,');
    expect(body).toContain('Set up your parent account');
    expect(body).toContain('to see grades, work and messages any time');
    expect(html).toContain('href="http://localhost:3000/signup/alhaadiacademy/parent"');
    expect(body).not.toContain('Open SchoolMule');
    expect(body).toContain('You get this summary on Fridays.');
    expect(body).not.toContain('Turn it off');
    expect(body).not.toContain('Announcements always arrive right away');
  });
});
