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
function answer({ year = null, days = 0, homeroom = null, classTeacher = null } = {}) {
  const calls = [];
  db.query.mockImplementation((sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM school_years')) return Promise.resolve({ rows: year ? [year] : [] });
    if (sql.includes('FROM general_attendance')) return Promise.resolve({ rows: [{ days }] });
    if (sql.includes('FROM users WHERE user_id')) return Promise.resolve({ rows: homeroom ? [{ username: homeroom }] : [] });
    if (sql.includes('FROM classes c')) return Promise.resolve({ rows: classTeacher ? [{ teacher_name: classTeacher }] : [] });
    return Promise.resolve({ rows: [] });
  });
  return calls;
}

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

    expect(ctx).toEqual({ reportDate: '2026-11-14', schoolYearLabel: '2026-2027', daysAbsent: 5, teacherName: 'Class Teacher' });
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
    expect(calls.some((c) => c.sql.includes('FROM classes c'))).toBe(false);
  });

  it("otherwise names the grade's Kindergarten class teacher for that year, or nobody", async () => {
    const calls = answer({ year: YEAR, classTeacher: 'Class Teacher' });
    expect((await loadProgressReportContext(STUDENT, { reportDate: '2026-11-14' })).teacherName).toBe('Class Teacher');
    const classCall = calls.find((c) => c.sql.includes('FROM classes c'));
    expect(classCall.params).toEqual(['stu-1', 'JK', 'year-1', 'TESTSCHOOL']);
    expect(classCall.sql).toContain("ILIKE '%kindergarten%'");

    answer({ year: YEAR, classTeacher: null });
    expect((await loadProgressReportContext(STUDENT, { reportDate: '2026-11-14' })).teacherName).toBe('');
  });

  it('defaults the report date to today where the school is', async () => {
    answer({ year: YEAR });
    const ctx = await loadProgressReportContext(STUDENT, { timezone: 'America/Toronto' });
    expect(ctx.reportDate).toBe(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }));
  });
});
