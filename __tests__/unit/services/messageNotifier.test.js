const mockSend = jest.fn().mockResolvedValue({ data: { id: 'email-1' } });
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: mockSend } })),
}));

const db = require('../../../config/database'); // mapped to the mock
const notifier = require('../../../services/messageNotifier');

const JOB = '77777777-7777-4777-8777-777777777777';
const CONVO = '44444444-4444-4444-8444-444444444444';
const RECIPIENT = '22222222-2222-4222-8222-222222222222';

const job = (over = {}) => ({ job_id: JOB, conversation_id: CONVO, recipient_id: RECIPIENT, school: 'ALHAADIACADEMY', attempts: 1, ...over });
const ctx = (over = {}) => ({
  job_id: JOB, conversation_id: CONVO, recipient_id: RECIPIENT, school: 'ALHAADIACADEMY', attempts: 1,
  recipient_email: 'parent@example.com', recipient_first_name: 'Layla', recipient_role: 'PARENT', recipient_archived: false,
  title: 'Unit 3 Quiz', assessment_id: 'a1', student_id: 's1', last_message_at: '2026-10-07T12:00:00Z',
  student_name: 'Amina Test', class_subject: 'Math', last_read_at: null, last_emailed_at: null, muted: false, ...over,
});
const msg = (over = {}) => ({ message_id: 'm1', body: 'Hello', created_at: '2026-10-07T12:00:00Z', sender_name: 'Ahmed Khan', attachment_count: 0, ...over });

/** Route db.query by SQL fragment; records every call. */
function makeRouter(table) {
  const calls = [];
  db.query.mockImplementation((sql, params) => {
    calls.push({ sql, params });
    for (const [frag, rows] of Object.entries(table)) {
      if (sql.includes(frag)) return Promise.resolve({ rows: typeof rows === 'function' ? rows(params) : rows });
    }
    return Promise.resolve({ rows: [] });
  });
  return { calls, ran: (frag) => calls.filter((c) => c.sql.includes(frag)) };
}

describe('messageNotifier', () => {
  beforeEach(() => { db._reset(); mockSend.mockClear(); mockSend.mockResolvedValue({ data: { id: 'email-1' } }); });
  afterEach(() => notifier.stopWorker());

  it('does nothing when no job is due', async () => {
    makeRouter({ 'FOR UPDATE SKIP LOCKED': [] });
    expect(await notifier.drainOnce()).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('skips when the recipient read the thread after the last message', async () => {
    const r = makeRouter({
      'FOR UPDATE SKIP LOCKED': [job()],
      'AS recipient_email': [ctx({ last_read_at: '2026-10-07T12:30:00Z' })],
    });
    expect(await notifier.drainOnce()).toBe(1);
    expect(mockSend).not.toHaveBeenCalled();
    const [finish] = r.ran('SET status = $2::text, last_error = $3');
    expect(finish.params.slice(0, 2)).toEqual([JOB, 'skipped']);
  });

  it('skips when muted', async () => {
    const r = makeRouter({ 'FOR UPDATE SKIP LOCKED': [job()], 'AS recipient_email': [ctx({ muted: true })] });
    await notifier.drainOnce();
    expect(mockSend).not.toHaveBeenCalled();
    expect(r.ran('SET status = $2::text, last_error = $3')[0].params[1]).toBe('skipped');
  });

  it('skips when nothing is unread for this recipient', async () => {
    const r = makeRouter({ 'FOR UPDATE SKIP LOCKED': [job()], 'AS recipient_email': [ctx()], 'AS attachment_count': [] });
    await notifier.drainOnce();
    expect(mockSend).not.toHaveBeenCalled();
    expect(r.ran('SET status = $2::text, last_error = $3')[0].params[1]).toBe('skipped');
  });

  it('sends one digest with every unread message and records sent + last_emailed_at', async () => {
    const r = makeRouter({
      'FOR UPDATE SKIP LOCKED': [job()],
      'AS recipient_email': [ctx({ last_emailed_at: '2026-10-07T11:00:00Z' })],
      'AS attachment_count': (params) => {
        // since = the later of last_emailed_at / last_read_at
        expect(params[2]).toBe('2026-10-07T11:00:00.000Z');
        return [msg(), msg({ message_id: 'm2', body: 'Second', attachment_count: 2 })];
      },
      'AS class_avg_pct': [{ assessment_id: 'a1', score: 14, max_score: 20, is_published: true }],
      'FROM schools': [{ name: 'Al Haadi Academy' }],
    });
    expect(await notifier.drainOnce()).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const email = mockSend.mock.calls[0][0];
    expect(email.from).toBe('messages@alhaadiacademy.ca');
    expect(email.to).toEqual(['parent@example.com']);
    expect(email.subject).toMatch(/2 new messages about Amina Test/);
    expect(email.html).toContain('Second');
    expect(email.html).toContain('2 attachments');
    expect(email.html).toContain('14/20 (70%)');
    expect(email.html).toContain(`/parent/messages?thread=${CONVO}`);
    expect(r.ran('SET status = $2::text, last_error = $3')[0].params.slice(0, 2)).toEqual([JOB, 'sent']);
    expect(r.ran('DO UPDATE SET last_emailed_at')).toHaveLength(1);
  });

  it('hides the score from a parent when the assessment is unpublished and links staff to /messages', async () => {
    makeRouter({
      'FOR UPDATE SKIP LOCKED': [job()],
      'AS recipient_email': [ctx({ recipient_role: 'TEACHER' })],
      'AS attachment_count': [msg({ sender_name: 'Layla Test' })],
      'AS class_avg_pct': [{ assessment_id: 'a1', score: 14, max_score: 20, is_published: false }],
    });
    await notifier.drainOnce();
    const email = mockSend.mock.calls[0][0];
    expect(email.html).toContain(`/messages?thread=${CONVO}`);
    expect(email.html).not.toContain('/parent/messages');
    // Staff see the score even when unpublished.
    expect(email.html).toContain('14/20 (70%)');

    mockSend.mockClear();
    makeRouter({
      'FOR UPDATE SKIP LOCKED': [job()],
      'AS recipient_email': [ctx({ recipient_role: 'PARENT' })],
      'AS attachment_count': [msg()],
      'AS class_avg_pct': [{ assessment_id: 'a1', score: 14, max_score: 20, is_published: false }],
    });
    await notifier.drainOnce();
    expect(mockSend.mock.calls[0][0].html).not.toContain('14/20');
  });

  it('a message posted during the send is still emailed: last_emailed_at is the last rendered message and a new job is queued', async () => {
    let calls = 0;
    const r = makeRouter({
      'FOR UPDATE SKIP LOCKED': [job()],
      'AS recipient_email': [ctx()],
      'AS attachment_count': () => (++calls === 1 ? [msg({ created_at: '2026-10-07T12:00:00Z' })] : [msg({ message_id: 'm2', body: 'posted mid-send', created_at: '2026-10-07T12:00:05Z' })]),
      'AS class_avg_pct': [],
    });
    await notifier.drainOnce();
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [emailed] = r.ran('DO UPDATE SET last_emailed_at');
    expect(emailed.params[2]).toBe('2026-10-07T12:00:00.000Z');
    const [requeue] = r.ran('INSERT INTO message_email_jobs');
    expect(requeue.params.slice(0, 3)).toEqual([CONVO, [RECIPIENT], 'ALHAADIACADEMY']);
  });

  it('marks sent before the participant update, so a bookkeeping failure never resends', async () => {
    const r = makeRouter({
      'FOR UPDATE SKIP LOCKED': [job()],
      'AS recipient_email': [ctx()],
      'AS attachment_count': [msg()],
      'DO UPDATE SET last_emailed_at': () => { throw new Error('db hiccup'); },
    });
    await notifier.drainOnce();
    const order = r.calls.map((c) => (c.sql.includes("SET status = $2::text, last_error = $3") ? 'finish' : c.sql.includes('DO UPDATE SET last_emailed_at') ? 'emailed' : null)).filter(Boolean);
    expect(order).toEqual(['finish', 'emailed']);
    expect(r.ran("CASE WHEN attempts >= $3 THEN 'failed'")).toHaveLength(0);
  });

  it('skips an invite-pending recipient (nothing to open yet)', async () => {
    const r = makeRouter({ 'FOR UPDATE SKIP LOCKED': [job()], 'AS recipient_email': [ctx({ recipient_invite_pending: true })] });
    await notifier.drainOnce();
    expect(mockSend).not.toHaveBeenCalled();
    expect(r.ran('SET status = $2::text, last_error = $3')[0].params.slice(1)).toEqual(['skipped', 'invite pending']);
  });

  it('sends the one invite reminder and marks the row', async () => {
    const r = makeRouter({
      "ps.invite_reminded_at IS NULL": [{ parent_student_link_id: 'link-1', parent_id: 'u1', parent_name: 'Hana Test', school: 'ALHAADIACADEMY', invite_conversation_id: CONVO, student_name: 'Bilal Test', email: 'hana@example.com', first_name: 'Hana', invited_by_name: 'Ahmed Khan' }],
      'INSERT INTO password_reset_tokens': [{ token: 'tok-r' }],
      'FROM schools': [{ name: 'Al Haadi Academy' }],
    });
    const n = await notifier.sendInviteReminders();
    expect(n).toBe(1);
    const email = mockSend.mock.calls[0][0];
    expect(email.to).toEqual(['hana@example.com']);
    expect(email.subject).toMatch(/Still waiting/);
    expect(email.html).toContain('token=tok-r');
    expect(r.ran('SET invite_reminded_at = NOW()')[0].params).toEqual(['link-1']);
  });

  it('requeues on a send failure and lets the retry query decide pending vs failed', async () => {
    mockSend.mockResolvedValueOnce({ error: { message: 'boom' } });
    const r = makeRouter({
      'FOR UPDATE SKIP LOCKED': [job({ attempts: 3 })],
      'AS recipient_email': [ctx()],
      'AS attachment_count': [msg()],
    });
    await notifier.drainOnce();
    const [retry] = r.ran("CASE WHEN attempts >= $3 THEN 'failed'");
    expect(retry.params).toEqual([JOB, 'boom', notifier.MAX_ATTEMPTS]);
    expect(r.ran('SET status = $2::text, last_error = $3')).toHaveLength(0);
  });

  it('stands down when the outbox table is missing', async () => {
    const err = new Error('relation "message_email_jobs" does not exist');
    err.code = '42P01';
    db.query.mockImplementation(() => Promise.reject(err));
    expect(await notifier.drainOnce()).toBe(0);
    db.query.mockClear();
    expect(await notifier.drainOnce()).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});
