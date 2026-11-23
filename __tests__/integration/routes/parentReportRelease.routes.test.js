// Report comments reach parents only once the report is emailed to the family
// (Al Haadi, 2026-11-23: parents were reading progress report comments as
// teachers typed them). A term's comments, ratings and PDF stay with the
// school until that student's report for the term is sent, and a send only
// counts for the school year it happened in: report rows are kept per student
// and term name, so last year's "sent" must not release this year's drafts.
// Staff see everything as before. Synthetic identities only (@example.com).

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');
const supabase = require('../../../config/supabaseClient');

const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440061';
const MONA_ID = '550e8400-e29b-41d4-a716-446655440064';
const asMona = { userId: MONA_ID, username: 'Mona Haddad', email: 'mona.haddad@example.com', role: 'PARENT' };

describe('Integration: parents see report comments once the report is emailed', () => {
  let pool, yearId, pastYearId, amalId, mathId, sciId, oldMathId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const user = (id, email, first, last, role) => pool.query(
    `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
     VALUES ($1, $2, $3, 'hashed', $4, $5, 'ALHAADIACADEMY', $6, true, true)`,
    [id, email, `${first} ${last}`, first, last, role],
  );
  const makeClass = (subject, year) => pool.query(
    `INSERT INTO classes (school, grade, subject, teacher_name, teacher_id, school_year_id)
     VALUES ('ALHAADIACADEMY', '5', $1, 'Ziad Teacher', $2, $3) RETURNING class_id`,
    [subject, TEACHER_ID, year],
  ).then((r) => r.rows[0].class_id);
  const progressComment = (classId, term, comment, createdAt) => pool.query(
    `INSERT INTO progress_report_feedback (student_id, class_id, term, work_habit, behavior, comment, created_at)
     VALUES ($1, $2, $3, 'G', 'E', $4, $5)`,
    [amalId, classId, term, comment, createdAt],
  );
  const report = (table, term, generatedAt, sentAt) => pool.query(
    `INSERT INTO ${table} (student_id, term, student_name, grade, file_path, school, generated_at, email_sent, email_sent_at)
     VALUES ($1, $2, 'Amal Haddad', '5', $3, 'ALHAADIACADEMY', $4, $5, $6)`,
    [amalId, term, `ALHAADIACADEMY/${table}-${term.replace(' ', '')}.pdf`, generatedAt, sentAt !== null, sentAt],
  );
  const feedback = async (yearHeader) => {
    let req = authenticatedRequest('get', `/api/parent-portal/students/${amalId}/feedback`, asMona);
    if (yearHeader) req = req.set('X-School-Year', yearHeader);
    const res = await req;
    expect(res.status).toBe(200);
    return res.body.data;
  };

  beforeEach(async () => {
    supabase._reset();
    // The seeded active year runs 2025-09-01 → 2026-06-30; last year ends in June and the
    // summer belongs to it until this year starts.
    yearId = (await pool.query(`SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active`)).rows[0].school_year_id;
    pastYearId = (await pool.query(
      `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
       SELECT 'ALHAADIACADEMY', school_id, '2024-2025', DATE '2024-09-01', DATE '2025-06-27', FALSE
         FROM schools WHERE school_code = 'ALHAADIACADEMY'
       RETURNING school_year_id`,
    )).rows[0].school_year_id;

    await user(TEACHER_ID, 'ziad.teacher@example.com', 'Ziad', 'Teacher', 'TEACHER');
    await user(MONA_ID, 'mona.haddad@example.com', 'Mona', 'Haddad', 'PARENT');
    amalId = (await pool.query(
      `INSERT INTO students (name, grade, school, school_year_id, homeroom_teacher_id) VALUES ('Amal Haddad', '5', 'ALHAADIACADEMY', $1, $2) RETURNING student_id`,
      [yearId, TEACHER_ID],
    )).rows[0].student_id;
    await pool.query(
      `INSERT INTO parent_students (student_id, parent_id, parent_name, parent_email, relation, school) VALUES ($1, $2, 'Mona Haddad', 'mona.haddad@example.com', 'Mother', 'ALHAADIACADEMY')`,
      [amalId, MONA_ID],
    );

    mathId = await makeClass('Math', yearId);
    sciId = await makeClass('Science', yearId);
    oldMathId = await makeClass('Math', pastYearId);

    await progressComment(mathId, 'Term 1', 'Math, Term 1: sent home.', '2025-11-10T15:00:00Z');
    await progressComment(sciId, 'Term 2', 'Science, Term 2: still a draft.', '2026-03-01T15:00:00Z');
    await progressComment(oldMathId, 'Term 1', 'Last year: Term 1 was never sent.', '2024-11-10T15:00:00Z');
    await pool.query(
      `INSERT INTO report_card_feedback (student_id, class_id, term, work_habits, behavior, comment) VALUES ($1, $2, 'Term 1', 'G', 'G', 'Report card draft for Term 1.')`,
      [amalId, mathId],
    );

    await report('progress_reports', 'Term 1', '2025-11-18T15:00:00Z', '2025-11-20T15:00:00Z'); // emailed this year
    await report('progress_reports', 'Term 2', '2026-03-05T15:00:00Z', null); // generated, not sent
    // Sent last February; this year's Term 1 report card was generated since (the row is reused).
    await report('report_cards', 'Term 1', '2026-01-28T15:00:00Z', '2025-02-20T15:00:00Z');
  });

  it('shows only the terms whose report was emailed this school year, and only those PDFs', async () => {
    const data = await feedback();
    expect(data.progressFeedback.map((f) => f.comment)).toEqual(['Math, Term 1: sent home.'])
    expect(data.progressFeedback[0]).toMatchObject({ term: 'Term 1', workHabit: 'G', behavior: 'E' });
    // Last February's send doesn't release this year's report card drafts.
    expect(data.reportCardFeedback).toEqual([]);
    expect(data.progressReports.map((r) => r.term)).toEqual(['Term 1']);
  });

  it("releases a report card's comments once it is emailed this year", async () => {
    await pool.query(`UPDATE report_cards SET email_sent_at = '2026-01-30T15:00:00Z' WHERE student_id = $1`, [amalId]);
    const data = await feedback();
    expect(data.reportCardFeedback.map((f) => f.comment)).toEqual(['Report card draft for Term 1.']);
  });

  it("keeps to the selected school year: this year's send doesn't release last year's Term 1", async () => {
    const data = await feedback(pastYearId);
    expect(data.progressFeedback).toEqual([]);
    expect(data.progressReports).toEqual([]);
    // Sent over the summer (after last year ended, before this one started): it counts for last year.
    await pool.query(`UPDATE progress_reports SET generated_at = '2025-07-14T15:00:00Z', email_sent_at = '2025-07-15T15:00:00Z' WHERE student_id = $1 AND term = 'Term 1'`, [amalId]);
    const summer = await feedback(pastYearId);
    expect(summer.progressFeedback.map((f) => f.comment)).toEqual(['Last year: Term 1 was never sent.']);
    expect((await feedback()).progressFeedback).toEqual([]);
  });

  it('a report generated again after it was sent is hidden until it is sent again; its comments stay', async () => {
    await pool.query(`UPDATE progress_reports SET generated_at = '2025-11-25T15:00:00Z' WHERE student_id = $1 AND term = 'Term 1'`, [amalId]);
    const data = await feedback();
    expect(data.progressReports).toEqual([]);
    expect(data.progressFeedback.map((f) => f.comment)).toEqual(['Math, Term 1: sent home.']);
    const file = await authenticatedRequest('get', '/api/progress-reports/signed-url?path=ALHAADIACADEMY/progress_reports-Term1.pdf', asMona);
    expect(file.status).toBe(403);
    await pool.query(`UPDATE progress_reports SET email_sent_at = '2025-11-26T15:00:00Z' WHERE student_id = $1 AND term = 'Term 1'`, [amalId]);
    expect((await feedback()).progressReports.map((r) => r.term)).toEqual(['Term 1']);
  });

  it("the home card's latest comment is a released one", async () => {
    const res = await authenticatedRequest('get', '/api/parent-portal/summary', asMona);
    expect(res.status).toBe(200);
    const child = res.body.data.children.find((c) => c.studentId === amalId);
    expect(child.latestFeedback.comment).toBe('Math, Term 1: sent home.');
  });

  it('a parent can list and open only sent report PDFs; staff still see every report and comment', async () => {
    const listed = await authenticatedRequest('get', `/api/progress-reports/reports/student/${amalId}`, asMona);
    expect(listed.status).toBe(200);
    expect(listed.body.data.map((r) => r.term)).toEqual(['Term 1']);

    const unsent = await authenticatedRequest('get', '/api/progress-reports/signed-url?path=ALHAADIACADEMY/progress_reports-Term2.pdf', asMona);
    expect(unsent.status).toBe(403);
    const sent = await authenticatedRequest('get', '/api/progress-reports/signed-url?path=ALHAADIACADEMY/progress_reports-Term1.pdf', asMona);
    expect(sent.status).not.toBe(403);
    // This year's report card was generated after last year's send: not the family's yet.
    const card = await authenticatedRequest('get', `/api/report-cards/view/student?studentId=${amalId}&term=Term 1`, asMona);
    expect(card.status).toBe(200);
    expect(card.body.data).toEqual([]);
    const cardFile = await authenticatedRequest('get', '/api/report-cards/signed-url?path=ALHAADIACADEMY/report_cards-Term1.pdf', asMona);
    expect(cardFile.status).toBe(403);

    const staff = await authenticatedRequest('get', `/api/progress-reports/reports/student/${amalId}`);
    expect(staff.body.data.map((r) => r.term).sort()).toEqual(['Term 1', 'Term 2']);
    const staffFeedback = await authenticatedRequest('get', `/api/progress-reports/feedback/student/${amalId}`);
    expect(staffFeedback.status).toBe(200);
    expect(staffFeedback.body.data.map((f) => f.comment).sort()).toEqual([
      'Last year: Term 1 was never sent.',
      'Math, Term 1: sent home.',
      'Science, Term 2: still a draft.',
    ]);
  });
});
