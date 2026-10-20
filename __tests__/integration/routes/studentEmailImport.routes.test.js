// Student accounts → Import emails: parse a spreadsheet, preview which
// student each row is for, save the confirmed addresses. Rows are matched by
// name (and grade) against this year's students, never by email.
// Synthetic identities only: every address is @example.com.

jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: jest.fn().mockResolvedValue({ data: { id: 'e' } }) } })),
}));

const { getApp, authenticatedRequest } = require('../setup/integrationApp');
const { getTestPool } = require('../setup/setupTestDB');

const ADMIN_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEACHER_ID = '550e8400-e29b-41d4-a716-446655440001';
const asAdmin = { userId: ADMIN_ID, username: 'Office Admin', email: 'office@example.com', role: 'ADMIN' };
const asTeacher = { userId: TEACHER_ID, username: 'Ziad Teacher', email: 'teacher@example.com', role: 'TEACHER' };
const BASE = '/api/admin/student-accounts/emails';

describe('Integration: Import student emails', () => {
  let pool, yearId, amalId, samiId, mohammadId, ramiId;

  beforeAll(() => { getApp(); pool = getTestPool(); });

  const student = (name, grade, extra = {}) => pool.query(
    `INSERT INTO students (name, grade, school, school_year_id, student_email, father_email, previous_student_id)
     VALUES ($1, $2, 'ALHAADIACADEMY', $3, $4, $5, $6) RETURNING student_id`,
    [name, grade, extra.yearId ?? yearId, extra.studentEmail ?? null, extra.fatherEmail ?? null, extra.previousId ?? null],
  ).then((r) => r.rows[0].student_id);
  const emailOf = async (id) => (await pool.query(`SELECT student_email FROM students WHERE student_id = $1`, [id])).rows[0].student_email;
  const preview = (lines) => authenticatedRequest('post', `${BASE}/preview`, asAdmin).send({ lines });
  const codes = (candidate) => candidate.problems.map((p) => p.code);

  beforeEach(async () => {
    yearId = (await pool.query(
      `SELECT school_year_id FROM school_years WHERE school = 'ALHAADIACADEMY' AND is_active LIMIT 1`,
    )).rows[0].school_year_id;
    await pool.query(
      `INSERT INTO users (user_id, email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ($1, 'office@example.com', 'Office Admin', 'x', 'Office', 'Admin', 'ALHAADIACADEMY', 'ADMIN', true, true),
              ($2, 'teacher@example.com', 'Ziad Teacher', 'x', 'Ziad', 'Teacher', 'ALHAADIACADEMY', 'TEACHER', true, true)`,
      [ADMIN_ID, TEACHER_ID],
    );
    amalId = await student('Amal Haddad', '5');
    samiId = await student('Sami Haddad', '2', { fatherEmail: 'karim.haddad@example.com' });
    mohammadId = await student('Mohammad Ali', '7');
    ramiId = await student('Rami Saleh', '8', { studentEmail: 'rami.s@example.com' });
  });

  it('parse reads an uploaded CSV and refuses a file over 2 MB', async () => {
    const csv = 'First Name,Last Name,Email Address\nAmal,Haddad,amal.haddad@example.com\n';
    const res = await authenticatedRequest('post', `${BASE}/parse`, asAdmin).attach('file', Buffer.from(csv), 'students.csv');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      sheets: ['students.csv'], sheet: 'students.csv',
      rows: [['First Name', 'Last Name', 'Email Address'], ['Amal', 'Haddad', 'amal.haddad@example.com']],
    });

    const big = await authenticatedRequest('post', `${BASE}/parse`, asAdmin)
      .attach('file', Buffer.alloc(3 * 1024 * 1024, 'a'), 'big.csv');
    expect(big.status).toBe(400);
    expect(big.body.message).toBe('This file is over 2 MB.');
    expect((await authenticatedRequest('post', `${BASE}/parse`, asAdmin)).status).toBe(400);
  });

  it('preview matches by name and grade, offers near names to check, flags not found and problems per candidate', async () => {
    const res = await preview([
      { name: 'Amal Haddad', email: 'Amal.Haddad@example.com', grade: '5' },
      { name: 'Mohamad Ali', email: 'm.ali@example.com', grade: null },
      { name: 'Lina K', email: 'lina.k@example.com', grade: null },
      { name: 'Sami Haddad', email: 'karim.haddad@example.com', grade: '2' },
      { name: 'Rami Saleh', email: 'rami.saleh@example.com', grade: '8' },
    ]);
    expect(res.status).toBe(200);
    const [amal, mohamad, lina, sami, rami] = res.body.data.lines;
    expect(amal).toMatchObject({ index: 0, email: 'amal.haddad@example.com', match: { kind: 'matched' } });
    expect(amal.match.candidates).toEqual([{ studentId: amalId, name: 'Amal Haddad', grade: '5', currentEmail: null, problems: [] }]);
    expect(mohamad.match.kind).toBe('check');
    expect(mohamad.match.candidates.map((c) => c.studentId)).toEqual([mohammadId]);
    expect(codes(mohamad.match.candidates[0])).toEqual([]);
    expect(lina.match).toEqual({ kind: 'not_found', candidates: [] });
    expect(codes(sami.match.candidates[0])).toEqual(['family_address']);
    expect(sami.match.candidates[0].problems[0].blocking).toBe(true);
    expect(rami.match.candidates[0].problems).toEqual([
      { code: 'replaces_existing', blocking: false, defaultUnticked: true, message: 'Replaces rami.s@example.com' },
    ]);
  });

  it('a name with the wrong grade is only a candidate to check; with no grade a unique name matches', async () => {
    const [wrongGrade, noGrade] = (await preview([
      { name: 'Amal Haddad', email: 'amal.haddad@example.com', grade: '6' },
      { name: 'amal  HADDAD', email: 'amal.haddad@example.com', grade: null },
    ])).body.data.lines;
    expect(wrongGrade.match.kind).toBe('check');
    expect(noGrade.match).toMatchObject({ kind: 'matched', candidates: [{ studentId: amalId }] });
    // Two students with one name are never guessed between.
    const twin = await student('Amal Haddad', '2');
    const [line] = (await preview([{ name: 'Amal Haddad', email: 'amal.haddad@example.com', grade: null }])).body.data.lines;
    expect(line.match.kind).toBe('check');
    expect(line.match.candidates.map((c) => c.studentId).sort()).toEqual([amalId, twin].sort());
  });

  it('preview never matches by email: a row named Sami with Amal’s address is for Sami', async () => {
    await pool.query(`UPDATE students SET student_email = 'amal.haddad@example.com' WHERE student_id = $1`, [amalId]);
    const [line] = (await preview([{ name: 'Sami Haddad', email: 'amal.haddad@example.com', grade: null }])).body.data.lines;
    expect(line.match.candidates.map((c) => c.studentId)).toEqual([samiId]);
    expect(codes(line.match.candidates[0])).toContain('shared_with_student');
  });

  it('two rows with one address, or two rows for one student, are both flagged', async () => {
    const res = await preview([
      { name: 'Amal Haddad', email: 'shared@example.com', grade: null },
      { name: 'Sami Haddad', email: 'SHARED@example.com', grade: null },
      { name: 'Mohammad Ali', email: 'mo.ali@example.com', grade: null },
      { name: 'Mohammad Ali', email: 'mohammad.ali@example.com', grade: null },
    ]);
    const [a, b, c, d] = res.body.data.lines;
    expect(codes(a.match.candidates[0])).toContain('duplicate_in_list');
    expect(codes(b.match.candidates[0])).toContain('duplicate_in_list');
    expect(codes(c.match.candidates[0])).toContain('duplicate_in_list');
    expect(codes(d.match.candidates[0])).toContain('duplicate_in_list');
    expect(c.match.candidates[0].problems.find((p) => p.code === 'duplicate_in_list').message).toBe('Two rows are for Mohammad Ali.');
  });

  it('save writes clean items to the row and its later rows, refuses blocking ones item by item', async () => {
    const { rows: [nextYear] } = await pool.query(
      `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
       SELECT school, school_id, '2026-2027', '2026-09-01', '2027-06-30', false FROM school_years WHERE school_year_id = $1
       RETURNING school_year_id`, [yearId],
    );
    const amalNext = await student('Amal Haddad', '6', { yearId: nextYear.school_year_id, previousId: amalId });

    const res = await authenticatedRequest('post', BASE, asAdmin).send({
      items: [
        { studentId: amalId, email: ' Amal.Haddad@example.com ' },
        { studentId: samiId, email: 'karim.haddad@example.com' },
        { studentId: '00000000-0000-4000-8000-000000000001', email: 'ghost@example.com' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.saved).toBe(1);
    expect(res.body.data.results.map((r) => [r.outcome, r.problems.map((p) => p.code)])).toEqual([
      ['saved', []],
      ['refused', ['family_address']],
      ['refused', ['not_found']],
    ]);
    expect(await emailOf(amalId)).toBe('amal.haddad@example.com');
    expect(await emailOf(amalNext)).toBe('amal.haddad@example.com');
    expect(await emailOf(samiId)).toBeNull();
  });

  it('is admin only, and refused for a year that is not the active one', async () => {
    expect((await authenticatedRequest('post', `${BASE}/preview`, asTeacher).send({ lines: [] })).status).toBe(403);
    const { rows: [nextYear] } = await pool.query(
      `INSERT INTO school_years (school, school_id, label, start_date, end_date, is_active)
       SELECT school, school_id, '2026-2027', '2026-09-01', '2027-06-30', false FROM school_years WHERE school_year_id = $1
       RETURNING school_year_id`, [yearId],
    );
    const res = await authenticatedRequest('post', `${BASE}/preview`, asAdmin)
      .set('X-School-Year', nextYear.school_year_id)
      .send({ lines: [{ name: 'Amal Haddad', email: 'a@example.com', grade: null }] });
    expect(res.status).toBe(409);
  });

  it('refuses an empty or oversized list', async () => {
    expect((await preview([])).status).toBe(400);
    const lines = Array.from({ length: 1001 }, (_, i) => ({ name: `S ${i}`, email: `s${i}@example.com`, grade: null }));
    expect((await preview(lines)).status).toBe(400);
  });

  it('parse reads a real .xlsx and its second sheet on request, and refuses another file type', async () => {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Staff').addRow(['Name']);
    const ws = wb.addWorksheet('Students');
    ws.addRow(['Full name', 'Email']);
    ws.addRow(['Amal Haddad', 'amal.haddad@example.com']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const first = await authenticatedRequest('post', `${BASE}/parse`, asAdmin).attach('file', buf, 'roster.xlsx');
    expect(first.body.data).toMatchObject({ sheets: ['Staff', 'Students'], sheet: 'Staff' });
    const second = await authenticatedRequest('post', `${BASE}/parse`, asAdmin)
      .field('sheet', 'Students').attach('file', buf, 'roster.xlsx');
    expect(second.body.data).toEqual({
      sheets: ['Staff', 'Students'], sheet: 'Students', rows: [['Full name', 'Email'], ['Amal Haddad', 'amal.haddad@example.com']],
    });
    const pdf = await authenticatedRequest('post', `${BASE}/parse`, asAdmin).attach('file', Buffer.from('%PDF-1.4'), 'roster.pdf');
    expect(pdf.status).toBe(400);
    expect(pdf.body.message).toBe("We couldn't read this file. Save it as .xlsx or .csv and try again.");
  });

  it('a student who already has a login is changed with Edit email, never by an import', async () => {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (email, username, password, first_name, last_name, school, role, is_verified, is_verified_school)
       VALUES ('amal.old@example.com', 'Amal Haddad', '!', 'Amal', 'Haddad', 'ALHAADIACADEMY', 'STUDENT', true, true) RETURNING user_id`,
    );
    await pool.query(`INSERT INTO student_account_links (user_id, student_id, school_year_id) VALUES ($1, $2, $3)`, [u.user_id, amalId, yearId]);
    const [line] = (await preview([{ name: 'Amal Haddad', email: 'amal.new@example.com', grade: '5' }])).body.data.lines;
    expect(line.match.candidates[0].problems.map((p) => [p.code, p.blocking])).toContainEqual(['has_login', true]);
    const save = await authenticatedRequest('post', BASE, asAdmin).send({ items: [{ studentId: amalId, email: 'amal.new@example.com' }] });
    expect(save.body.data.results[0]).toMatchObject({ outcome: 'refused' });
    expect(await emailOf(amalId)).toBeNull();
  });

  it("another school's admin can't match or save onto this school's students", async () => {
    await pool.query(`INSERT INTO schools (school_code, name) VALUES ('PLAYGROUND', 'Playground') ON CONFLICT DO NOTHING`);
    // Another school's admin: their own account (RBAC reads it from the database).
    const asOther = { ...asAdmin, userId: '550e8400-e29b-41d4-a716-446655440099', school: 'PLAYGROUND' };
    const [line] = (await authenticatedRequest('post', `${BASE}/preview`, asOther)
      .send({ lines: [{ name: 'Amal Haddad', email: 'amal.haddad@example.com', grade: '5' }] })).body.data.lines;
    expect(line.match).toEqual({ kind: 'not_found', candidates: [] });
    const save = await authenticatedRequest('post', BASE, asOther).send({ items: [{ studentId: amalId, email: 'amal.haddad@example.com' }] });
    expect(save.body.data).toMatchObject({ saved: 0, results: [{ outcome: 'refused', problems: [{ code: 'not_found' }] }] });
    expect(await emailOf(amalId)).toBeNull();
  });
});