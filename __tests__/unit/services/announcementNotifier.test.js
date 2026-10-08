const mockSend = jest.fn().mockResolvedValue({ data: { id: 'email-1' } });
jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: mockSend } })) }));

const db = require('../../../config/database'); // mapped to the mock
const notifier = require('../../../services/messageNotifier');

const JOB = '77777777-7777-4777-8777-777777777777';
const ANN = '44444444-4444-4444-8444-444444444444';
const job = (over = {}) => ({ job_id: JOB, announcement_id: ANN, recipient_id: 'p1', recipient_email: 'layla@example.com', kind: 'account', school: 'ALHAADIACADEMY', attempts: 1, ...over });
const ctx = (over = {}) => ({
  job_id: JOB, kind: 'account', recipient_id: 'p1', recipient_email: 'layla@example.com', school: 'ALHAADIACADEMY',
  announcement_id: ANN, title: 'Forms due Friday', body: 'Please return <the form>.\nThanks', scope: 'class', grade: null, deleted_at: null, author_id: 't1',
  class_subject: 'Math', class_grade: '6', author_name: 'Ahmed Khan', recipient_first_name: 'Layla', recipient_archived: false,
  attachment_count: 1, child_names: ['Amina Test'], ...over,
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
const CLAIM = 'RETURNING job_id, announcement_id, recipient_id, recipient_email, kind, school, attempts';
// The claim query is re-run until it returns nothing; hand out one job, then an empty queue.
const once = (j) => { let n = 0; return () => (n++ === 0 ? [j] : []); };

describe('announcement notifier', () => {
  beforeEach(() => {
    db._reset();
    mockSend.mockClear();
    mockSend.mockResolvedValue({ data: { id: 'email-1' } });
    process.env.FRONTEND_URL = 'https://app.example.com';
  });
  afterEach(() => notifier.stopWorker());

  it('does nothing when no announcement job is due', async () => {
    makeRouter({ [CLAIM]: [] });
    expect(await notifier.drainAnnouncements()).toBe(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('account kind: letterhead email with escaped body, scope subject, portal link; marks sent', async () => {
    const r = makeRouter({ [CLAIM]: once(job()), 'AS child_names': [ctx()], 'FROM schools': [{ name: 'Al Haadi Academy', school_code: 'ALHAADIACADEMY' }] });
    expect(await notifier.drainAnnouncements()).toBe(1);
    const email = mockSend.mock.calls[0][0];
    expect(email.from).toBe('messages@alhaadiacademy.ca');
    expect(email.to).toEqual(['layla@example.com']);
    expect(email.subject).toBe('Gr 6 Math: Forms due Friday');
    expect(email.html).toContain('Please return &lt;the form&gt;.<br>Thanks');
    expect(email.html).toContain('Amina Test');
    expect(email.html).toContain(`/parent/messages?tab=announcements&amp;announcement=${ANN}`);
    expect(email.html).toContain('1 attachment');
    expect(email.html).toContain('Read in SchoolMule');
    const [finish] = r.ran('UPDATE announcement_email_jobs\n    SET status = $2::text');
    expect(finish.params.slice(0, 2)).toEqual([JOB, 'sent']);
  });

  it('signup kind links to the school parent sign-up page; invite kind mints a token and links to reset-password', async () => {
    let r = makeRouter({
      [CLAIM]: once(job({ kind: 'signup', recipient_id: null, recipient_email: 'noor@example.com' })),
      'AS child_names': [ctx({ kind: 'signup', recipient_id: null, recipient_email: 'noor@example.com', recipient_first_name: 'Noor' })],
    });
    await notifier.drainAnnouncements();
    let html = mockSend.mock.calls[0][0].html;
    expect(html).toContain('https://app.example.com/signup/alhaadiacademy/parent');
    expect(html).toContain('Create your account');
    expect(r.ran('INSERT INTO password_reset_tokens')).toHaveLength(0);

    mockSend.mockClear();
    r = makeRouter({ [CLAIM]: once(job({ kind: 'invite' })), 'AS child_names': [ctx({ kind: 'invite' })], 'INSERT INTO password_reset_tokens': [{ token: 'tok-1' }] });
    await notifier.drainAnnouncements();
    html = mockSend.mock.calls[0][0].html;
    expect(r.ran('DELETE FROM password_reset_tokens')[0].params).toEqual(['p1']);
    expect(html).toContain('token=tok-1');
    expect(html).toContain(encodeURIComponent(`/parent/messages?tab=announcements&announcement=${ANN}`));
    expect(html).toContain('Set up your account');
  });

  it('skips a removed announcement and an archived recipient without sending', async () => {
    let r = makeRouter({ [CLAIM]: once(job()), 'AS child_names': [ctx({ deleted_at: '2026-10-08T13:00:00Z' })] });
    await notifier.drainAnnouncements();
    expect(mockSend).not.toHaveBeenCalled();
    expect(r.ran('SET status = $2::text')[0].params.slice(1)).toEqual(['skipped', 'announcement removed']);
    r = makeRouter({ [CLAIM]: once(job()), 'AS child_names': [ctx({ recipient_archived: true })] });
    await notifier.drainAnnouncements();
    expect(mockSend).not.toHaveBeenCalled();
    expect(r.ran('SET status = $2::text')[0].params.slice(1)).toEqual(['skipped', 'recipient archived']);
  });

  it('renders the row as it is at send time (an edit inside the window ships corrected)', async () => {
    makeRouter({ [CLAIM]: once(job()), 'AS child_names': [ctx({ title: 'Forms due Monday' })] });
    await notifier.drainAnnouncements();
    expect(mockSend.mock.calls[0][0].subject).toBe('Gr 6 Math: Forms due Monday');
  });

  it('requeues on a send failure through retryOrFailAnnouncementJob', async () => {
    mockSend.mockResolvedValueOnce({ error: { message: 'boom' } });
    const r = makeRouter({ [CLAIM]: once(job({ attempts: 3 })), 'AS child_names': [ctx()] });
    await notifier.drainAnnouncements();
    const [retry] = r.ran("CASE WHEN attempts >= $3 THEN 'failed'");
    expect(retry.sql).toContain('announcement_email_jobs');
    expect(retry.params).toEqual([JOB, 'boom', notifier.MAX_ATTEMPTS]);
  });

  it('stops at the batch limit and stands down when the table is missing', async () => {
    let n = 0;
    makeRouter({ [CLAIM]: () => (++n <= 50 ? [job({ job_id: `j${n}` })] : []), 'AS child_names': [ctx({ deleted_at: 'x' })] });
    expect(await notifier.drainAnnouncements(5)).toBe(5);
    const err = new Error('relation "announcement_email_jobs" does not exist');
    err.code = '42P01';
    db.query.mockImplementation(() => Promise.reject(err));
    expect(await notifier.drainAnnouncements()).toBe(0);
    db.query.mockClear();
    expect(await notifier.drainAnnouncements()).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });
});
