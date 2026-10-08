const { getConversationDigestEmailHTML } = require('../../../templates/emailTemplate');

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
