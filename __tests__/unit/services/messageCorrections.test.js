// The corrected-message email, built at send time from the message as it is
// then. Synthetic names only.

const db = require('../../../config/database');
const supabase = require('../../../config/supabaseClient');
const { messageCorrectionHandler } = require('../../../services/messageCorrections');

const MESSAGE = '55555555-5555-4555-8555-555555555555';
const CONVO = '44444444-4444-4444-8444-444444444444';
const RECIPIENT = '66666666-6666-4666-8666-666666666666';

const job = {
  id: 'o1', kind: 'message_correction', school: 'ALHAADIACADEMY', recipient_user_id: RECIPIENT,
  recipient_email: 'dana@example.com', subject_id: MESSAGE, payload: { messageId: MESSAGE, conversationId: CONVO },
};

const context = (over = {}) => ({
  message_id: MESSAGE, conversation_id: CONVO, body: 'The corrected text', created_at: '2026-11-09T14:20:00Z', deleted_at: null,
  sender_name: 'Ms. Rivera', title: 'Unit 3 Quiz', student_name: 'Sam Example', class_subject: 'Math', assessment_id: null,
  includes_student: false, classwork_item_id: null, has_guardians: true, guardians_hidden: false,
  recipient_first_name: 'Dana', recipient_role: 'PARENT', recipient_archived: false, recipient_invite_pending: false, muted: false,
  ...over,
});

function route({ ctx = context(), files = [] } = {}) {
  db.query.mockImplementation((sql) => {
    if (sql.includes('AS recipient_invite_pending')) return Promise.resolve({ rows: ctx ? [ctx] : [] });
    if (sql.includes('FROM message_attachments')) return Promise.resolve({ rows: files });
    if (sql.includes('INSERT INTO password_reset_tokens')) return Promise.resolve({ rows: [{ token: 'invite-token' }] });
    return Promise.resolve({ rows: [] });
  });
}

describe('messageCorrectionHandler', () => {
  beforeEach(() => { db._reset(); supabase._reset(); });

  it('builds the email from the current text and says it is a correction', async () => {
    route();
    const built = await messageCorrectionHandler.build(job, [], { now: new Date() });
    expect(built.message.to).toEqual(['dana@example.com']);
    expect(built.message.subject).toMatch(/corrected/i);
    expect(built.message.html).toContain('The corrected text');
    expect(built.message.html).toContain('corrected version');
  });

  it('attaches the files on the message now', async () => {
    route({ files: [{ attachment_id: 'a1', message_id: MESSAGE, file_path: 'p/right.pdf', file_name: 'right.pdf', mime_type: 'application/pdf', size_bytes: 3 }] });
    supabase._mockStorage.download.mockResolvedValue({ data: new Blob(['pdf']), error: null });
    const built = await messageCorrectionHandler.build(job, [], { now: new Date() });
    expect(built.message.attachments.map((a) => a.filename)).toEqual(['right.pdf']);
  });

  it('sends nothing for a message removed since', async () => {
    route({ ctx: context({ deleted_at: '2026-11-09T14:30:00Z' }) });
    expect((await messageCorrectionHandler.build(job, [], { now: new Date() })).skip).toMatch(/removed/);
  });

  it('sends nothing to someone archived or who muted the thread', async () => {
    route({ ctx: context({ recipient_archived: true }) });
    expect((await messageCorrectionHandler.build(job, [], { now: new Date() })).skip).toBeTruthy();
    route({ ctx: context({ muted: true }) });
    expect((await messageCorrectionHandler.build(job, [], { now: new Date() })).skip).toBeTruthy();
  });

  it('gives a guardian with only an invite a fresh link to set up their account', async () => {
    route({ ctx: context({ recipient_invite_pending: true }) });
    const built = await messageCorrectionHandler.build(job, [], { now: new Date() });
    expect(built.message.html).toContain('token=invite-token');
    expect(built.message.html).toContain('invite=1');
  });
});
