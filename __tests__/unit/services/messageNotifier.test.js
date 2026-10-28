const mockSend = jest.fn().mockResolvedValue({ data: { id: 'email-1' } });
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: mockSend } })),
}));

const db = require('../../../config/database'); // mapped to the mock
const supabase = require('../../../config/supabaseClient'); // mapped to the mock
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
const msg = (over = {}) => ({
  message_id: 'm1', body: 'Hello', created_at: '2026-10-07T12:00:00Z', created_at_exact: '2026-10-07 12:00:00.000228+00',
  sender_name: 'Ahmed Khan', attachment_count: 0, ...over,
});

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

  it('attaches the message files to the email and names them; oversized ones fall back to a link', async () => {
    supabase._reset();
    supabase._mockStorage.download.mockResolvedValue({ data: { arrayBuffer: async () => Buffer.from('%PDF') }, error: null });
    const r = makeRouter({
      'FOR UPDATE SKIP LOCKED': [job()],
      'AS recipient_email': [ctx()],
      'AS attachment_count': [msg({ attachment_count: 2 })],
      'FROM message_attachments WHERE message_id = ANY': [
        { attachment_id: 'a1', message_id: 'm1', file_path: 'S/c/m1/a.pdf', file_name: 'worksheet.pdf', mime_type: 'application/pdf', size_bytes: 4 },
        { attachment_id: 'a2', message_id: 'm1', file_path: 'S/c/m1/b.pdf', file_name: 'huge.pdf', mime_type: 'application/pdf', size_bytes: 30 * 1024 * 1024 },
      ],
    });
    expect(await notifier.drainOnce()).toBe(1);
    const email = mockSend.mock.calls[0][0];
    expect(email.attachments).toEqual([{ filename: 'worksheet.pdf', content: Buffer.from('%PDF') }]);
    expect(email.html).toContain('Attached: worksheet.pdf');
    expect(email.html).toContain('huge.pdf — too large to attach');
    expect(r.ran('FROM message_attachments WHERE message_id = ANY')[0].params).toEqual([['m1']]);
    expect(r.ran('SET status = $2::text, last_error = $3')[0].params.slice(0, 2)).toEqual([JOB, 'sent']);
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
      'AS recipient_email': [ctx({ last_emailed_at: '2026-10-07T11:00:00Z', since_exact: '2026-10-07 11:00:00.123456+00' })],
      'AS attachment_count': (params) => {
        // since = the later of last_emailed_at / last_read_at, from SQL as text (microseconds kept)
        expect(params[2]).toBe('2026-10-07 11:00:00.123456+00');
        return [msg(), msg({ message_id: 'm2', body: 'Second', attachment_count: 2 })];
      },
      'AS class_avg_pct': [{ assessment_id: 'a1', score: 14, max_score: 20, is_published: true }],
      'FROM schools': [{ name: 'Al Haadi Academy', slug: 'al-haadi-academy', email: 'office@school.example', email_reply_to: ['admin@school.example'] }],
    });
    expect(await notifier.drainOnce()).toBe(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const email = mockSend.mock.calls[0][0];
    // No verified school domain on the row: sent under the school's name from the platform's messages address.
    expect(email.from).toBe('"Al Haadi Academy" <messages@test.com>');
    expect(email.replyTo).toEqual(['admin@school.example', 'office@school.example']);
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

  it('a STUDENT recipient gets the /student/messages link, their own subject, and never an unpublished score', async () => {
    const r = makeRouter({
      'FOR UPDATE SKIP LOCKED': [job()],
      'AS recipient_email': [ctx({
        recipient_role: 'STUDENT', recipient_email: 'amal.haddad@example.com', recipient_first_name: 'Amal',
        includes_student: true, recipient_in_thread: true, student_email_on: true, guardians_hidden: false, has_guardians: true,
      })],
      'AS attachment_count': [msg({ sender_name: 'Ziad Teacher', body: 'Nice start' })],
      'AS class_avg_pct': [{ assessment_id: 'a1', score: 14, max_score: 20, is_published: false }],
    });
    expect(await notifier.drainOnce()).toBe(1);
    const email = mockSend.mock.calls[0][0];
    expect(email.to).toEqual(['amal.haddad@example.com']);
    expect(email.subject).toBe('Ziad Teacher sent you a message about Unit 3 Quiz');
    expect(email.html).toContain(`/student/messages?thread=${CONVO}`);
    expect(email.html).not.toContain('/parent/messages');
    expect(email.html).not.toContain('14/20');
    expect(email.html).toContain('Your parents are in every conversation');
    expect(r.ran('SET status = $2::text, last_error = $3')[0].params.slice(0, 2)).toEqual([JOB, 'sent']);

    // Published: the score may show.
    mockSend.mockClear();
    makeRouter({
      'FOR UPDATE SKIP LOCKED': [job()],
      'AS recipient_email': [ctx({ recipient_role: 'STUDENT', includes_student: true, recipient_in_thread: true, student_email_on: true })],
      'AS attachment_count': [msg(), msg({ message_id: 'm2', body: 'Second' })],
      'AS class_avg_pct': [{ assessment_id: 'a1', score: 14, max_score: 20, is_published: true }],
    });
    await notifier.drainOnce();
    expect(mockSend.mock.calls[0][0].subject).toBe('2 new messages about Unit 3 Quiz');
    expect(mockSend.mock.calls[0][0].html).toContain('14/20');
  });

  it('the student email says parents are in the thread only when a guardian is, and the thread is not kept from them', async () => {
    const studentCtx = { recipient_role: 'STUDENT', includes_student: true, recipient_in_thread: true, student_email_on: true };
    for (const [over, says] of [
      [{ has_guardians: true, guardians_hidden: false }, true],
      [{ has_guardians: false, guardians_hidden: false }, false], // no linked guardian account
      [{ has_guardians: true, guardians_hidden: true }, false], // an item thread kept from parents
    ]) {
      mockSend.mockClear();
      makeRouter({ 'FOR UPDATE SKIP LOCKED': [job()], 'AS recipient_email': [ctx({ ...studentCtx, ...over })], 'AS attachment_count': [msg()] });
      await notifier.drainOnce();
      expect([over, mockSend.mock.calls[0][0].html.includes('Your parents are in every conversation')]).toEqual([over, says]);
    }
  });

  it('skips a student no longer in the thread, a school that does not email students, and a guardian on a hidden item thread', async () => {
    const cases = [
      [{ recipient_role: 'STUDENT', includes_student: true, recipient_in_thread: false, student_email_on: true }, 'not in thread'],
      [{ recipient_role: 'STUDENT', includes_student: true, recipient_in_thread: true, student_email_on: false }, 'student email off'],
      [{ recipient_role: 'PARENT', includes_student: true, guardians_hidden: true }, 'hidden from guardians'],
    ];
    for (const [over, reason] of cases) {
      mockSend.mockClear();
      const r = makeRouter({ 'FOR UPDATE SKIP LOCKED': [job()], 'AS recipient_email': [ctx(over)], 'AS attachment_count': [msg()] });
      await notifier.drainOnce();
      expect(mockSend).not.toHaveBeenCalled();
      expect(r.ran('SET status = $2::text, last_error = $3')[0].params.slice(1)).toEqual(['skipped', reason]);
    }
  });

  it('a guardian on a student thread (not hidden) is emailed as today', async () => {
    makeRouter({
      'FOR UPDATE SKIP LOCKED': [job()],
      'AS recipient_email': [ctx({ includes_student: true, guardians_hidden: false })],
      'AS attachment_count': [msg({ sender_name: 'Amal Haddad' })],
    });
    await notifier.drainOnce();
    const email = mockSend.mock.calls[0][0];
    expect(email.subject).toBe("Amal Haddad sent a message about Amina Test's Unit 3 Quiz");
    expect(email.html).toContain(`/parent/messages?thread=${CONVO}`);
  });

  it('a message posted during the send is still emailed: last_emailed_at is the last rendered message and a new job is queued', async () => {
    let calls = 0;
    const r = makeRouter({
      'FOR UPDATE SKIP LOCKED': [job()],
      'AS recipient_email': [ctx()],
      'AS attachment_count': () => (++calls === 1
        ? [msg({ created_at: '2026-10-07T12:00:00Z', created_at_exact: '2026-10-07 12:00:00.934228+00' })]
        : [msg({ message_id: 'm2', body: 'posted mid-send', created_at: '2026-10-07T12:00:05Z', created_at_exact: '2026-10-07 12:00:05.000001+00' })]),
      'AS class_avg_pct': [],
    });
    await notifier.drainOnce();
    expect(mockSend).toHaveBeenCalledTimes(1);
    // The exact Postgres text, never a millisecond Date: '.934' would make m1 look unsent and loop.
    const [emailed] = r.ran('DO UPDATE SET last_emailed_at');
    expect(emailed.params[2]).toBe('2026-10-07 12:00:00.934228+00');
    expect(r.ran('AS attachment_count')[1].params[2]).toBe('2026-10-07 12:00:00.934228+00');
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

describe('promoteScheduled (worker tick)', () => {
  beforeEach(() => { db._reset(); });

  it('returns the classwork it posted', async () => {
    makeRouter({ "SET status = 'posted'": [{ item_id: 'i1', class_id: 'c1' }] });
    expect(await notifier.promoteScheduled()).toEqual([{ item_id: 'i1', class_id: 'c1' }]);
  });

  it('a failure is logged, never thrown', async () => {
    db.query.mockRejectedValueOnce(new Error('connection reset'));
    await expect(notifier.promoteScheduled()).resolves.toEqual([]);
  });

  it('stands down once classwork_items is missing, without querying again', async () => {
    const err = new Error('relation "classwork_items" does not exist');
    err.code = '42P01';
    db.query.mockRejectedValueOnce(err);
    await expect(notifier.promoteScheduled()).resolves.toEqual([]);
    db.query.mockClear();
    await expect(notifier.promoteScheduled()).resolves.toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('classroomTick and drainClassroom (worker tick, T21)', () => {
  const classroom = require('../../../services/classroom/classroomNotifier');
  let spies = [];
  beforeEach(() => {
    db._reset();
    // An earlier test stood the scheduler down (missing table); a worker start clears that.
    notifier.startWorker(60 * 60 * 1000);
    notifier.stopWorker();
  });
  afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; });

  it('posts scheduled work, queues its new-work emails, then runs the sweeps', async () => {
    const order = [];
    makeRouter({ "SET status = 'posted'": [{ item_id: 'i1', class_id: 'c1' }, { item_id: 'i2', class_id: 'c1' }] });
    spies = [
      jest.spyOn(classroom, 'enqueueNewWork').mockImplementation(async (ids, opts) => { order.push(['enqueueNewWork', ids, opts.now]); return 2; }),
      jest.spyOn(classroom, 'runSchedule').mockImplementation(async (now) => { order.push(['runSchedule', now]); }),
      jest.spyOn(classroom, 'drainClassroomJobs').mockImplementation(async () => { order.push(['drainClassroomJobs']); return 0; }),
    ];
    const now = new Date('2026-10-16T20:30:00Z');
    await notifier.classroomTick(now);
    // Sending is the tick's last step (drainClassroom), after the message queues.
    expect(order).toEqual([['enqueueNewWork', ['i1', 'i2'], now], ['runSchedule', now]]);
  });

  it('queues nothing when nothing was posted; neither step ever throws', async () => {
    makeRouter({});
    spies = [
      jest.spyOn(classroom, 'enqueueNewWork').mockResolvedValue(0),
      jest.spyOn(classroom, 'runSchedule').mockRejectedValue(new Error('connection reset')),
      jest.spyOn(classroom, 'drainClassroomJobs').mockRejectedValue(new Error('connection reset')),
    ];
    await expect(notifier.classroomTick(new Date())).resolves.toBeUndefined();
    expect(classroom.enqueueNewWork).not.toHaveBeenCalled();
    await expect(notifier.drainClassroom()).resolves.toBe(0);
  });
});

describe('the worker pass and the email outbox (report card sends)', () => {
  const outbox = require('../../../services/email/outbox');
  let spies = [];
  beforeEach(() => { db._reset(); makeRouter({}); });
  afterEach(() => {
    notifier.stopWorker();
    spies.forEach((s) => s.mockRestore());
    spies = [];
  });
  const settle = async (until) => {
    for (let i = 0; i < 200 && !until(); i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  it('a kick runs a pass now; a pass that sent a full batch runs again at once, until the outbox is drained', async () => {
    const drain = jest.spyOn(outbox, 'drainOutbox')
      .mockResolvedValueOnce(outbox.DRAIN_LIMIT)
      .mockResolvedValueOnce(outbox.DRAIN_LIMIT)
      .mockResolvedValue(3);
    spies = [drain];
    notifier.startWorker(60 * 60 * 1000);
    outbox.kick();
    await settle(() => drain.mock.calls.length >= 3);
    // Three passes back to back; the third sent less than a batch, so it stops there.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drain).toHaveBeenCalledTimes(3);
  });

  it('a kick during a pass runs one more pass after it; a stopped worker ignores kicks', async () => {
    let release;
    const drain = jest.spyOn(outbox, 'drainOutbox')
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(0); }))
      .mockResolvedValue(0);
    spies = [drain];
    notifier.startWorker(60 * 60 * 1000);
    outbox.kick();
    await settle(() => drain.mock.calls.length === 1 && release);
    outbox.kick(); // mid-pass
    release();
    await settle(() => drain.mock.calls.length >= 2);
    expect(drain).toHaveBeenCalledTimes(2);

    notifier.stopWorker();
    outbox.kick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drain).toHaveBeenCalledTimes(2);
  });
});
