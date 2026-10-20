const db = require('../../../__mocks__/config/database');
const assembly = require('../../../../services/staffAttendance/assembly');

const SCHOOL = 'ALHAADIACADEMY';

const person = (attendance_date, status = 'PRESENT', hours = null) => ({
  teacher_id: 't1', first_name: 'Aisha', last_name: 'Khan', username: 'akhan',
  attendance_date, status, notes: null, hours,
});

/** Routes the assembly's four loads by SQL, whatever order they run in. */
const primeDb = ({ rows, openDays, schedule }) => {
  db.query.mockImplementation((sql) => {
    if (/LEFT JOIN teacher_attendance ta/.test(sql)) return Promise.resolve({ rows });
    if (/is_elapsed/.test(sql)) return Promise.resolve({ rows: openDays });
    if (/FROM staff_pay_schedules/.test(sql)) return Promise.resolve({ rows: schedule ? [schedule] : [] });
    return Promise.resolve({ rows: [] }); // work-day inputs: everyone on the default profile
  });
};

const schedule = {
  frequency: 'MONTHLY', pay_day_of_month: 25, second_pay_day_of_month: null,
  anchor_pay_date: null, default_hours_per_day: '6.50', work_day_start: null,
};

beforeEach(() => db._reset());

describe('assembly.buildPayPeriods', () => {
  const periods = [
    { payDate: '2026-09-25', startDate: '2026-08-26', endDate: '2026-09-25' },
    { payDate: '2026-10-25', startDate: '2026-09-26', endDate: '2026-10-25' },
  ];

  it('loads the whole span once and carves it into periods', async () => {
    primeDb({
      rows: [person('2026-09-10', 'ABSENT'), person('2026-09-28', 'PRESENT', 4)],
      openDays: [
        { day: '2026-09-09', is_elapsed: true },
        { day: '2026-09-10', is_elapsed: true },
        { day: '2026-09-28', is_elapsed: true },
        { day: '2026-10-01', is_elapsed: false },
      ],
      schedule,
    });

    const built = await assembly.buildPayPeriods(periods, SCHOOL);

    const rangeLoads = db.query.mock.calls.filter(([sql]) => /LEFT JOIN teacher_attendance ta/.test(sql));
    expect(rangeLoads).toHaveLength(1);
    expect(rangeLoads[0][1].slice(0, 3)).toEqual(['2026-08-26', '2026-10-25', SCHOOL]);

    expect(built.map((p) => p.payDate)).toEqual(['2026-09-25', '2026-10-25']);

    const sept = built[0].teachers[0];
    expect(sept.records.map((r) => `${r.attendanceDate}:${r.status}`)).toEqual(['2026-09-09:PRESENT', '2026-09-10:ABSENT']);
    expect(sept).toMatchObject({ workingDays: 2, presentDays: 1, absentDays: 1, hoursWorked: 6.5 });

    const oct = built[1].teachers[0];
    expect(oct.records.map((r) => `${r.attendanceDate}:${r.hours}`)).toEqual(['2026-09-28:4']);
    expect(oct).toMatchObject({ workingDays: 2, elapsedWorkingDays: 1, hoursWorked: 4 });
  });

  it('labels each period with how far it has run', async () => {
    primeDb({ rows: [person(null)], openDays: [], schedule });
    const built = await assembly.buildPayPeriods(periods, SCHOOL);
    const today = assembly.torontoToday();
    expect(built[0].isComplete).toBe(built[0].endDate <= today);
    expect(built[0].throughDate <= today).toBe(true);
  });

  it('returns nothing for no periods without touching the database', async () => {
    await expect(assembly.buildPayPeriods([], SCHOOL)).resolves.toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('assembly.buildSchoolRange', () => {
  it('counts everything the queries returned, trusting their date scoping', async () => {
    primeDb({ rows: [person('2026-09-10', 'ABSENT')], openDays: [{ day: '2026-09-10', is_elapsed: true }], schedule });
    const { teachers, workingDays } = await assembly.buildSchoolRange('2026-09-01', '2026-09-30', SCHOOL);
    expect(workingDays).toBe(1);
    expect(teachers[0]).toMatchObject({ absentDays: 1, hoursWorked: 0 });
  });
});

describe('paid holidays', () => {
  // A school-day row as selectSchoolDays returns it: closed_staff_day is the
  // staff treatment of a closure covering the day (null when school is open).
  const day = (d, closed_staff_day = null, closure_title = null, is_elapsed = true) => ({
    day: d, is_elapsed, closed_staff_day, closure_title,
  });
  const range = (rows, openDays, profile = null) => {
    db.query.mockImplementation((sql) => {
      if (/LEFT JOIN teacher_attendance ta/.test(sql)) return Promise.resolve({ rows });
      if (/is_elapsed/.test(sql)) return Promise.resolve({ rows: openDays });
      if (/FROM staff_pay_schedules/.test(sql)) return Promise.resolve({ rows: [schedule] });
      if (/custom_days/.test(sql) && profile) return Promise.resolve({ rows: [{ user_id: 't1', is_archived: false, ...profile }] });
      return Promise.resolve({ rows: [] });
    });
    return assembly.buildSchoolRange('2026-10-01', '2026-10-31', SCHOOL).then((r) => r.teachers[0]);
  };
  const byDate = (t) => Object.fromEntries(t.records.map((r) => [r.attendanceDate, r]));

  it('pays an Ontario stat holiday the school closed for, without counting it present or scheduled', async () => {
    const t = await range([person(null)], [day('2026-10-09'), day('2026-10-12', 'off', 'Thanksgiving'), day('2026-10-13')]);
    expect(byDate(t)['2026-10-12']).toEqual({
      attendanceDate: '2026-10-12', status: 'HOLIDAY', notes: null, hours: null, holidayName: 'Thanksgiving',
    });
    expect(t).toMatchObject({ workingDays: 2, presentDays: 2, absentDays: 0, holidayDays: 1, hoursWorked: 19.5 });
  });

  it('pays a stat holiday even when the calendar never mentions it', async () => {
    const t = await range([person(null)], [day('2026-10-12')]);
    expect(byDate(t)['2026-10-12']).toMatchObject({ status: 'HOLIDAY', holidayName: 'Thanksgiving' });
    expect(t).toMatchObject({ workingDays: 0, holidayDays: 1, hoursWorked: 6.5 });
  });

  it('pays a closure the school marked as a paid holiday, under its calendar title', async () => {
    const t = await range([person(null)], [day('2026-10-14', 'paid', 'Eid Day')]);
    expect(byDate(t)['2026-10-14']).toMatchObject({ status: 'HOLIDAY', holidayName: 'Eid Day' });
    expect(t).toMatchObject({ workingDays: 0, holidayDays: 1, hoursWorked: 6.5 });
  });

  it('treats a staff work day (a PA day) as an ordinary school day', async () => {
    const t = await range([person(null)], [day('2026-10-16', 'work', 'PA Day')]);
    expect(byDate(t)['2026-10-16']).toMatchObject({ status: 'PRESENT' });
    expect(t).toMatchObject({ workingDays: 1, presentDays: 1, holidayDays: 0, hoursWorked: 6.5 });
  });

  it('leaves an unpaid closure that is not a stat holiday empty', async () => {
    const t = await range([person(null)], [day('2026-10-14', 'off', 'Easter Monday')]);
    expect(t.records).toEqual([]);
    expect(t).toMatchObject({ workingDays: 0, holidayDays: 0, hoursWorked: 0 });
  });

  it('lets a real record on a holiday stand in for it', async () => {
    const t = await range([person('2026-10-12', 'PRESENT', 3)], [day('2026-10-12', 'off', 'Thanksgiving')]);
    expect(t.records).toHaveLength(1);
    expect(t.records[0]).toMatchObject({ status: 'PRESENT', hours: 3 });
    expect(t).toMatchObject({ holidayDays: 0, hoursWorked: 3 });
  });

  it('pays a holiday only on a day the person works, and only once it has passed', async () => {
    const partTimer = await range([person(null)], [day('2026-10-12', 'off', 'Thanksgiving')], { custom_days: [2, 3, 4] });
    expect(partTimer).toMatchObject({ records: [], holidayDays: 0, hoursWorked: 0 });

    const ahead = await range([person(null)], [day('2026-10-12', 'off', 'Thanksgiving', false)]);
    expect(ahead).toMatchObject({ records: [], holidayDays: 0, hoursWorked: 0 });
  });
});
