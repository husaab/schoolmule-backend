const { getConversationDigestEmailHTML, getGuardianInviteEmailHTML } = require('../../../templates/emailTemplate');

describe('getConversationDigestEmailHTML', () => {
  const base = {
    recipientFirstName: 'Layla',
    studentName: 'Amina Test',
    className: 'Math',
    title: 'Unit 3 Quiz',
    contextLine: '14/20 (70%)',
    link: 'http://localhost:3000/parent/messages?thread=abc',
    schoolName: 'Al Haadi Academy',
    schoolInfo: null,
  };

  it('escapes bodies, lists each message, names attachments and links to the thread', () => {
    const html = getConversationDigestEmailHTML({
      ...base,
      messages: [
        { senderName: 'Ahmed Khan', body: 'Hello <b>there</b>\nsecond line', sentAtLabel: 'Oct 7, 2:14 PM', attachmentCount: 1 },
        { senderName: 'Ahmed Khan', body: 'Follow-up', sentAtLabel: 'Oct 7, 2:16 PM', attachmentCount: 0 },
      ],
    });
    expect(html).toContain('2 new messages');
    expect(html).toContain('Hello &lt;b&gt;there&lt;/b&gt;<br>second line');
    expect(html).toContain('1 attachment');
    expect(html).toContain('thread=abc');
    expect(html).toContain('14/20 (70%)');
    expect(html).not.toContain('<b>there</b>');
  });

  it('names attached files and flags the ones that were too large', () => {
    const html = getConversationDigestEmailHTML({
      ...base,
      messages: [{
        senderName: 'Ahmed Khan', body: 'See attached', sentAtLabel: 'Oct 7, 2:14 PM', attachmentCount: 2,
        attachments: [{ fileName: 'a <b>.pdf', attached: true }, { fileName: 'big.mov', attached: false }],
      }],
    });
    expect(html).toContain('Attached: a &lt;b&gt;.pdf');
    expect(html).toContain('big.mov — too large to attach');
    expect(html).toContain('The attached files are also kept in SchoolMule');
    expect(html).not.toContain('2 attachments');
  });

  it('uses a single-message heading naming the sender', () => {
    const html = getConversationDigestEmailHTML({
      ...base,
      contextLine: null,
      messages: [{ senderName: 'Ahmed Khan', body: 'Hi', sentAtLabel: 'Oct 7, 2:14 PM', attachmentCount: 0 }],
    });
    expect(html).toContain('New message from Ahmed Khan');
    expect(html).not.toContain('attachment');
  });
});

describe('getGuardianInviteEmailHTML', () => {
  const base = { recipientFirstName: 'Hana', teacherName: 'Ahmed Khan', studentFirstName: 'Bilal', title: 'Missing homework', url: 'http://x/reset-password?token=t&invite=1&next=%2Fparent%2Fmessages', schoolName: 'Al Haadi Academy', schoolInfo: null };
  it('names the teacher and student, quotes the preview, links the signup', () => {
    const html = getGuardianInviteEmailHTML({ ...base, preview: 'Hi <Hana>, please…' });
    expect(html).toContain('Ahmed Khan sent you a message about Bilal');
    expect(html).toContain('Hi &lt;Hana&gt;, please…');
    expect(html).toContain('token=t&amp;invite=1');
    expect(html).toContain('Create your account');
  });
  it('omits the quote when there is no preview and switches to the reminder heading', () => {
    const html = getGuardianInviteEmailHTML({ ...base, preview: null, reminder: true });
    expect(html).toContain('Still waiting for you');
    expect(html).not.toContain('please…');
  });
});
