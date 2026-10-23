// Reply reminders against the real schema: the sweep (services/replyReminders
// runSchedule) with a fixed `now`, then the outbox drain that builds and sends
// each email. The seeded school year runs Sep 2025 to Jun 2026, so the dates
// are real school weeks: Wed Mar 4, 2026 is the parent's message in most
// cases, and Family Day (Mon Feb 16, 2026) is the stat holiday.
// Synthetic identities only (@example.com).

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'email-1' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const reminders = require('../../../services/replyReminders');
const { torontoInstant } = require('../../../services/classroom/classroomDigest');
const { getResend } = require('../../../utils/emailUtils');
const { deliverQueuedEmails } = require('../../helpers/emailOutbox');

const LEAD_ID = '660e8400-e29b-41d4-a716-446655440001';
const CO_ID = '660e8400-e29b-41d4-a716-446655440002';
const OFFICE_ID = '660e8400-e29b-41d4-a716-446655440003';
const PARENT_ID = '660e8400-e29b-41d4-a716-446655440004';
const PENDING_ID = '660e8400-e29b-41d4-a716-446655440005';
const STUDENT_USER_ID = '660e8400-e29b-41d4-a716-446655440006';

const MIN_MS = 60 * 1000;
/** A Toronto wall-clock time on a date, e.g. at('2026-03-06', 7, 30). */
const at = (date, hour, minute = 0) => new Date(torontoInstant(date, hour).getTime() + minute * MIN_MS);

describe('Integration: reply reminders', () => {
  let pool, yearId, classId, assessmentId, studentId;
  const sent = () => getResend().emails.send.mock.calls.map(([msg]) => msg);

  const user = (id, email, first, last, role, { password = 'hashed', honorific = null, archived = false } = {}) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school, honorific, is_archived)
     VALUES ($1, $2, $3, $4, $5, $6, 'ALHAADIACADEMY', $7, TRUE, TRUE, $8, $9)`,
    [id, email, `${first} ${last}`, password, first, last, role, honorific, archived],
  );
  const settings = (replyReminders, parentNudge) => pool.query(
    `INSERT INTO school_classroom_settings (school, reply_reminders, parent_nudge) VALUES ('ALHAADIACADEMY', $1, $2)
     ON CONFLICT (school) DO UPDATE SET reply_reminders = $1, parent_nudge = $2`,
    [replyReminders, parentNudge],
  );
  const conversation = async ({ kind = 'assessment', teacherId = null, cls = classId, title = 'Handwriting 2', status = 'open', assessment = assessmentId } = {}) =>
    (await pool.query(
      `INSERT INTO conversations (school, student_id, class_id, assessment_id, title, status, kind, teacher_id)
       VALUES ('ALHAADIACADEMY', $1, $2, $3, $4, $5, $6, $7) RETURNING conversation_id`,
      [studentId, cls, kind === 'assessment' ? assessment : null, title, status, kind, teacherId],
    )).rows[0].conversation_id;
  const say = async (conversationId, senderId, role, body, when) =>
    (await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, sender_role, kind, body, created_at)
       VALUES ($1, $2, $3, 'message', $4, $5) RETURNING message_id`,
      [conversationId, senderId, role, body, when],
    )).rows[0].message_id;
  const outbox = async (conversationId) => (await pool.query(
    `SELECT kind, status, LOWER(recipient_email) AS email, (payload->>'step')::int AS step, skip_reason
     FROM email_outbox WHERE subject_id = $1 ORDER BY created_at, recipient_email`,
    [conversationId],
  )).rows;
  const sweep = async (now) => {
    reminders.resetScheduleState();
    return reminders.runSchedule(now);
  };

  beforeAll(() => { getApp(); pool = getTestPool(); });

  beforeEach(async () => {
    getResend().emails.send.mockClear();
    ({ rows: [{ school_year_id: yearId }] } = await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active`,
    ));
    await user(LEAD_ID, 'lead.teacher@example.com', 'Doha', 'Teacher', 'TEACHER', { honorific: 'Ms.' });
    // A co-teacher who is also a full admin: reminded with the lead, never sent the office email.
    await user(CO_ID, 'co.admin@example.com', 'Sami', 'Coadmin', 'ADMIN', { honorific: 'Mr.' });
    await user(OFFICE_ID, 'office.admin@example.com', 'Lina', 'Office', 'ADMIN', { honorific: 'Ms.' });
    await user(PARENT_ID, 'rania.parent@example.com', 'Rania', 'Parent', 'PARENT');
    await user(PENDING_ID, 'pending.parent@example.com', 'Omar', 'Pending', 'PARENT', { password: '!' });
    await user(STUDENT_USER_ID, 'amina.student@example.com', 'Amina', 'Student', 'STUDENT');
    classId = (await pool.query(
      `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id, term_name)
       VALUES ('ALHAADIACADEMY', '4', 'Arabic', 'Doha Teacher', $1, $2, 'Term 1') RETURNING class_id`,
      [LEAD_ID, yearId],
    )).rows[0].class_id;
    await pool.query('INSERT INTO class_teachers (class_id, teacher_id) VALUES ($1, $2)', [classId, CO_ID]);
    assessmentId = (await pool.query(
      `INSERT INTO assessments (class_id, name, weight_points, max_score) VALUES ($1, 'Handwriting 2', 10, 10) RETURNING assessment_id`,
      [classId],
    )).rows[0].assessment_id;
    studentId = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id) VALUES ('Amina Test', '4', 'ALHAADIACADEMY', $1) RETURNING student_id`,
      [yearId],
    )).rows[0].student_id;
    await pool.query('INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)', [classId, studentId]);
    for (const [id, name, email] of [[PARENT_ID, 'Rania Parent', 'rania.parent@example.com'], [PENDING_ID, 'Omar Pending', 'pending.parent@example.com']]) {
      await pool.query(
        `INSERT INTO parent_students (parent_id, student_id, parent_name, parent_email, relation, school)
         VALUES ($1, $2, $3, $4, 'Mother', 'ALHAADIACADEMY')`,
        [id, studentId, name, email],
      );
    }
    await settings(true, true);
  });

  it('reminds the class teachers on school days 2 and 4, tells the office on day 5, with the whole message each time', async () => {
    const id = await conversation();
    await say(id, PARENT_ID, 'PARENT', 'Salam,', at('2026-03-04', 17, 14));
    const long = await say(id, PARENT_ID, 'PARENT', 'Amina was home sick on Thursday.\nCan she make it up this week?', at('2026-03-04', 17, 18));
    await pool.query(
      `INSERT INTO message_attachments (message_id, file_path, file_name, mime_type, size_bytes)
       VALUES ($1, 'x/y/z.pdf', 'doctors-note.pdf', 'application/pdf', 100)`,
      [long],
    );

    // Thursday is school day 1; on Friday the sweep waits for 7 am.
    await sweep(at('2026-03-05', 7, 30));
    await sweep(at('2026-03-06', 6, 59));
    expect(await outbox(id)).toEqual([]);

    await sweep(at('2026-03-06', 7, 30));
    expect((await outbox(id)).map((r) => [r.kind, r.email, r.step])).toEqual([
      ['reply_reminder', 'co.admin@example.com', 1],
      ['reply_reminder', 'lead.teacher@example.com', 1],
    ]);
    await deliverQueuedEmails(pool);
    const first = sent();
    expect(first.map((m) => m.to[0]).sort()).toEqual(['co.admin@example.com', 'lead.teacher@example.com']);
    const toLead = first.find((m) => m.to[0] === 'lead.teacher@example.com');
    expect(toLead.subject).toBe('A parent is waiting to hear from you: Amina Test (Arabic)');
    expect(toLead.html).toContain('Hi Doha,');
    expect(toLead.html).toContain('Rania Parent (Mother)');
    expect(toLead.html).toContain('Amina was home sick on Thursday.<br>Can she make it up this week?');
    expect(toLead.html).toContain('doctors-note.pdf');
    expect(toLead.html).toContain(`/messages?thread=${id}`);

    // The same day again adds nothing; Monday is only one school day after Friday.
    await sweep(at('2026-03-06', 9, 0));
    await sweep(at('2026-03-09', 7, 30));
    expect(await outbox(id)).toHaveLength(2);

    getResend().emails.send.mockClear();
    await sweep(at('2026-03-10', 7, 30));
    await deliverQueuedEmails(pool);
    expect(sent().map((m) => m.subject)).toEqual([
      'Last reminder: a parent is waiting for your reply (Amina Test)',
      'Last reminder: a parent is waiting for your reply (Amina Test)',
    ]);
    expect(sent()[0].html).toContain('This is the last reminder');

    getResend().emails.send.mockClear();
    await sweep(at('2026-03-11', 7, 30));
    await deliverQueuedEmails(pool);
    expect(sent().map((m) => m.to[0])).toEqual(['office.admin@example.com']);
    const [office] = sent();
    expect(office.subject).toBe("No reply yet: Rania Parent's message about Amina Test");
    expect(office.html).toContain("Mr. Sami Coadmin and Ms. Doha Teacher were reminded twice and haven't replied.");
    expect(office.html).toContain('Can she make it up this week?');

    // Done: nothing more the next day.
    await sweep(at('2026-03-12', 7, 30));
    expect(await outbox(id)).toHaveLength(5);

    // All Messages shows the badges.
    const res = await authenticatedRequest('get', '/api/messaging/conversations?status=open');
    const item = res.body.data.find((c) => c.conversationId === id);
    expect(item.replyReminders).toEqual({ reminders: 2, officeToldAt: expect.any(String), nudgedAt: null });
  });

  it('skips the stat holiday: written Thursday before Family Day, reminded Tuesday', async () => {
    const id = await conversation();
    await say(id, PARENT_ID, 'PARENT', 'Question about the quiz', at('2026-02-12', 18));
    await sweep(at('2026-02-16', 8));
    expect(await outbox(id)).toEqual([]);
    await sweep(at('2026-02-17', 8));
    expect((await outbox(id)).map((r) => r.step)).toEqual([1, 1]);
  });

  it('stops once anyone at school replies or the conversation is resolved; a student alone never starts it', async () => {
    const answered = await conversation();
    await say(answered, PARENT_ID, 'PARENT', 'Hello?', at('2026-03-04', 9));
    const resolved = await conversation({ kind: 'general', teacherId: LEAD_ID, title: 'Lunch', status: 'resolved' });
    await say(resolved, PARENT_ID, 'PARENT', 'Thanks for lunch', at('2026-03-04', 9));
    const fromStudent = await conversation({ kind: 'general', teacherId: LEAD_ID, title: 'My homework' });
    await say(fromStudent, STUDENT_USER_ID, 'STUDENT', 'Is it due Friday?', at('2026-03-04', 9));

    await sweep(at('2026-03-06', 7, 30));
    expect(await outbox(resolved)).toEqual([]);
    expect(await outbox(fromStudent)).toEqual([]);
    expect(await outbox(answered)).toHaveLength(2);

    // The teacher answers after the sweep and before the email goes: it is skipped.
    await say(answered, LEAD_ID, 'TEACHER', 'Yes, I saw it.', at('2026-03-06', 7, 31));
    await deliverQueuedEmails(pool);
    expect(sent()).toEqual([]);
    expect((await outbox(answered)).map((r) => [r.status, r.skip_reason])).toEqual([
      ['skipped', reminders.SKIP.ANSWERED],
      ['skipped', reminders.SKIP.ANSWERED],
    ]);
    await sweep(at('2026-03-10', 7, 30));
    expect(await outbox(answered)).toHaveLength(2);
  });

  it('tells the office at the first reminder when no teacher can be emailed', async () => {
    await pool.query('UPDATE users SET is_archived = TRUE WHERE user_id = $1', [LEAD_ID]);
    const id = await conversation({ kind: 'general', teacherId: LEAD_ID, title: 'Bus pickup' });
    await say(id, PARENT_ID, 'PARENT', 'Who picks up after 4?', at('2026-03-04', 9));
    await sweep(at('2026-03-06', 7, 30));
    expect((await outbox(id)).map((r) => [r.kind, r.step])).toEqual([
      ['reply_escalation', 3], ['reply_escalation', 3],
    ]);
    await deliverQueuedEmails(pool);
    // Both admins: the co-teacher is not on this General thread.
    expect(sent().map((m) => m.to[0]).sort()).toEqual(['co.admin@example.com', 'office.admin@example.com']);
    expect(sent()[0].html).toContain("There's no teacher with an email address to remind");
  });

  it('nudges a parent once when a teacher message has had no reply for 2 school days', async () => {
    const id = await conversation({ kind: 'general', teacherId: LEAD_ID, title: 'Lab report' });
    await say(id, LEAD_ID, 'TEACHER', 'Could Amina hand in the lab report by Wednesday?', at('2026-03-02', 15));
    const replied = await conversation({ kind: 'general', teacherId: LEAD_ID, title: 'Field trip' });
    await say(replied, LEAD_ID, 'TEACHER', 'Field trip form?', at('2026-03-02', 15));
    await say(replied, PARENT_ID, 'PARENT', 'Signed it.', at('2026-03-02', 19));
    const stale = await conversation({ kind: 'general', teacherId: LEAD_ID, title: 'Old note' });
    await say(stale, LEAD_ID, 'TEACHER', 'An old note', at('2026-02-02', 15));

    await sweep(at('2026-03-03', 7, 30));
    expect(await outbox(id)).toEqual([]);
    await sweep(at('2026-03-04', 7, 30));
    // The invite-pending guardian is left to the invite reminder.
    expect((await outbox(id)).map((r) => [r.kind, r.email])).toEqual([['reply_nudge', 'rania.parent@example.com']]);
    expect(await outbox(replied)).toEqual([]);
    expect(await outbox(stale)).toEqual([]);

    await deliverQueuedEmails(pool);
    const [nudge] = sent();
    expect(nudge.subject).toBe('Ms. Doha Teacher sent you a message about Amina Test');
    expect(nudge.html).toContain('Could Amina hand in the lab report by Wednesday?');
    expect(nudge.html).toContain('/email-login?next=');
    await sweep(at('2026-03-05', 7, 30));
    expect(await outbox(id)).toHaveLength(1);
  });

  it('does nothing while the school has both switches off', async () => {
    await settings(false, false);
    const id = await conversation();
    await say(id, PARENT_ID, 'PARENT', 'Hello?', at('2026-03-04', 9));
    expect(await sweep(at('2026-03-06', 7, 30))).toEqual({ reminders: 0, office: 0, nudges: 0 });
    expect(await outbox(id)).toEqual([]);
  });

  it('saves the two switches from the classroom settings', async () => {
    const { body: { data: current } } = await authenticatedRequest('get', '/api/admin/classroom-settings');
    expect(current).toMatchObject({ replyReminders: true, parentNudge: true });
    const { updatedAt, ...body } = current;
    const res = await authenticatedRequest('put', '/api/admin/classroom-settings').send({ ...body, replyReminders: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ replyReminders: false, parentNudge: true });
  });
});
