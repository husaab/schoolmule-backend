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
