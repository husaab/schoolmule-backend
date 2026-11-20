const db = require('../../../config/database');
const {
  parseReportDate,
  isValidReportDate,
  loadProgressReportContext,
} = require('../../../services/kindergartenProgressReport');

const STUDENT = {
  student_id: 'stu-1',
  school: 'TESTSCHOOL',
  grade: 'JK',
  homeroom_teacher_id: null,
};

// Answers each query by what it reads, and records the calls.
function answer({ year = null, days = 0, homeroom = null, classTeacher = null, coTeachers = [], choice = null } = {}) {
  const calls = [];
  db.query.mockImplementation((sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM school_years')) return Promise.resolve({ rows: year ? [year] : [] });
    if (sql.includes('FROM general_attendance')) return Promise.resolve({ rows: [{ days }] });
    if (sql.includes('FROM class_teachers')) return Promise.resolve({ rows: coTeachers });
    if (sql.includes('FROM classes c')) {
      return Promise.resolve({ rows: classTeacher ? [{ class_id: 'class-k', teacher_id: 'teacher-k', teacher_name: classTeacher, teacher_signature_path: null }] : [] });
    }
    if (sql.includes('_teacher_assistants')) return Promise.resolve({ rows: choice ? [choice] : [] });
    if (sql.includes('FROM users')) return Promise.resolve({ rows: homeroom ? [{ user_id: 'u-1', name: homeroom, signature_path: null }] : [] });
    return Promise.resolve({ rows: [] });
  });
  return calls;
}

const NOBODY = { assistantName: '', signatures: { teacher: null, assistant: null } };

const YEAR = { school_year_id: 'year-1', label: '2026-2027', start_date: '2026-09-07', end_date: '2027-06-25' };

describe('report date input', () => {
  it('accepts a real YYYY-MM-DD date or nothing', () => {
    expect(parseReportDate({})).toEqual({ reportDate: null });
    expect(parseReportDate({ reportDate: '' })).toEqual({ reportDate: null });
    expect(parseReportDate({ reportDate: '2026-11-14' })).toEqual({ reportDate: '2026-11-14' });
  });

  it('refuses anything else', () => {
    expect(parseReportDate({ reportDate: '2026-02-30' }).error).toBeDefined();
    expect(parseReportDate({ reportDate: 'Nov 14, 2026' }).error).toBeDefined();
    expect(parseReportDate({ reportDate: 20261114 }).error).toBeDefined();
    expect(isValidReportDate('2028-02-29')).toBe(true);
  });
});

describe('loadProgressReportContext', () => {
  it('counts absences from the start of the report date’s school year up to that date', async () => {
    const calls = answer({ year: YEAR, days: 5, classTeacher: 'Class Teacher' });
    const ctx = await loadProgressReportContext(STUDENT, { reportDate: '2026-11-14' });

    expect(ctx).toEqual({
      reportDate: '2026-11-14', schoolYearLabel: '2026-2027', schoolYearId: 'year-1', daysAbsent: 5, teacherName: 'Class Teacher', ...NOBODY,
    });
    const yearCall = calls.find((c) => c.sql.includes('FROM school_years'));
    expect(yearCall.params).toEqual(['TESTSCHOOL', '2026-11-14']);
    const absences = calls.find((c) => c.sql.includes('FROM general_attendance'));
    expect(absences.params).toEqual(['stu-1', '2026-09-07', '2026-11-14']);
  });

  it('stops counting at the end of the school year', async () => {
    const calls = answer({ year: YEAR });
    await loadProgressReportContext(STUDENT, { reportDate: '2027-07-10' });
    const absences = calls.find((c) => c.sql.includes('FROM general_attendance'));
    expect(absences.params).toEqual(['stu-1', '2026-09-07', '2027-06-25']);
  });

  it('counts every absence when the school has no school year', async () => {
    const calls = answer({ year: null });
    const ctx = await loadProgressReportContext(STUDENT, { reportDate: '2026-11-14' });
    expect(ctx.schoolYearLabel).toBeNull();
    const absences = calls.find((c) => c.sql.includes('FROM general_attendance'));
    expect(absences.params).toEqual(['stu-1', null, '2026-11-14']);
  });

  it('names the homeroom teacher first', async () => {
    const calls = answer({ year: YEAR, homeroom: 'Homeroom Teacher', classTeacher: 'Class Teacher' });
    const ctx = await loadProgressReportContext({ ...STUDENT, homeroom_teacher_id: 'u-1' }, { reportDate: '2026-11-14' });
    expect(ctx.teacherName).toBe('Homeroom Teacher');
    // The Kindergarten class is still read (its co-teachers are the assistants),
    // preferring one the homeroom teacher teaches.
    expect(calls.find((c) => c.sql.includes('FROM classes c')).params).toEqual(['stu-1', 'JK', 'year-1', 'TESTSCHOOL', 'u-1']);
  });

  it("otherwise names the grade's Kindergarten class teacher for that year, or nobody", async () => {
    const calls = answer({ year: YEAR, classTeacher: 'Class Teacher' });
    expect((await loadProgressReportContext(STUDENT, { reportDate: '2026-11-14' })).teacherName).toBe('Class Teacher');
    const classCall = calls.find((c) => c.sql.includes('FROM classes c'));
    expect(classCall.params).toEqual(['stu-1', 'JK', 'year-1', 'TESTSCHOOL', null]);
    expect(classCall.sql).toContain("ILIKE '%kindergarten%'");

    answer({ year: YEAR, classTeacher: null });
    expect((await loadProgressReportContext(STUDENT, { reportDate: '2026-11-14' })).teacherName).toBe('');
  });

  it('reads through the client it is given (the report engine passes its own)', async () => {
    answer({ year: YEAR });
    db.query.mockClear();
    const client = { query: jest.fn(async (sql) => ({ rows: sql.includes('FROM school_years') ? [YEAR] : sql.includes('general_attendance') ? [{ days: 3 }] : [] })) };
    const ctx = await loadProgressReportContext(STUDENT, { reportDate: '2026-11-14', client });
    expect(ctx).toEqual({ reportDate: '2026-11-14', schoolYearLabel: '2026-2027', schoolYearId: 'year-1', daysAbsent: 3, teacherName: '', ...NOBODY });
    expect(client.query).toHaveBeenCalledTimes(3);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("names the class's only co-teacher as the assistant, and signs both saved signatures", async () => {
    answer({
      year: YEAR,
      homeroom: 'Homeroom Teacher',
      classTeacher: 'Class Teacher',
      coTeachers: [{ user_id: 'u-2', name: 'Co Teacher', signature_path: 'TESTSCHOOL/u-2/b.png' }],
    });
    const ctx = await loadProgressReportContext({ ...STUDENT, homeroom_teacher_id: 'u-1' }, { reportDate: '2026-11-14', term: 'Term 1' });
    expect(ctx.teacherName).toBe('Homeroom Teacher');
    expect(ctx.assistantName).toBe('Co Teacher');
    expect(ctx.signatures).toEqual({ teacher: null, assistant: 'https://mock-signed-url.com/TESTSCHOOL/u-2/b.png' });
  });

  it('prints no assistant when one was turned off for the term', async () => {
    answer({
      year: YEAR,
      classTeacher: 'Class Teacher',
      coTeachers: [{ user_id: 'u-2', name: 'Co Teacher', signature_path: null }],
      choice: { teacher_assistant_user_id: null, no_assistant: true },
    });
    const ctx = await loadProgressReportContext(STUDENT, { reportDate: '2026-11-14', term: 'Term 1' });
    expect(ctx.assistantName).toBe('');
  });

  it('defaults the report date to today where the school is', async () => {
    answer({ year: YEAR });
    const ctx = await loadProgressReportContext(STUDENT, { timezone: 'America/Toronto' });
    expect(ctx.reportDate).toBe(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }));
  });
});
