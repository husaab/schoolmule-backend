jest.mock('../../../../services/google/googleAuth', () => {
  class NeedsReconnectError extends Error {
    constructor(m = 'reconnect') { super(m); this.name = 'NeedsReconnectError'; this.needsReconnect = true; }
  }
  return { NeedsReconnectError, getAuthorizedClient: jest.fn() };
});
jest.mock('../../../../services/google/sheetsClient', () => ({
  ensureTabs: jest.fn(),
  readGrids: jest.fn(),
  applyMultiTabPlan: jest.fn(),
  applyRequests: jest.fn(),
}));
jest.mock('../../../../services/staffAttendance/assembly', () => {
  const actual = jest.requireActual('../../../../services/staffAttendance/assembly');
  return {
    ...actual,
    loadPaySchedule: jest.fn(),
    buildPayPeriods: jest.fn(),
    torontoToday: jest.fn(() => '2026-09-26'),
  };
});

const db = require('../../../__mocks__/config/database');
const googleAuth = require('../../../../services/google/googleAuth');
const sheetsClient = require('../../../../services/google/sheetsClient');
const assembly = require('../../../../services/staffAttendance/assembly');
const layout = require('../../../../services/google/staffHoursSheetLayout');
const { syncStaffHours, NOT_CONFIGURED } = require('../../../../services/google/staffHoursSyncEngine');

const SCHOOL = 'ALHAADIACADEMY';
const schedule = { frequency: 'MONTHLY', payDayOfMonth: 25, defaultHoursPerDay: 6.5 };

const linkRow = (over = {}) => ({
  link_id: 'l1', school: SCHOOL, spreadsheet_id: 'ss-1', spreadsheet_name: 'Staff hours',
  tab_widths: {}, last_synced_at: null, last_error: null, ...over,
});

const teacher = (over = {}) => ({
  teacherId: 't1', firstName: 'Aisha', lastName: 'Khan', username: 'akhan', records: [],
  workDays: [1, 2, 3, 4, 5], workingDays: 21, elapsedWorkingDays: 14, presentDays: 14, absentDays: 0,
  hoursPerDay: 6.5, hoursWorked: 91, ...over,
});

// The two periods periodsForYear yields for "monthly on the 25th", year
// start Sept 1, today Sept 26: paid Sept 25 (complete) and Oct 25 (running).
const builtPeriods = () => [
  { payDate: '2026-09-25', startDate: '2026-08-26', endDate: '2026-09-25', throughDate: '2026-09-25', isComplete: true, teachers: [teacher()] },
  { payDate: '2026-10-25', startDate: '2026-09-26', endDate: '2026-10-25', throughDate: '2026-09-26', isComplete: false, teachers: [teacher({ hoursWorked: 0, presentDays: 0, elapsedWorkingDays: 0 })] },
];
const SEPT = 'September 25, 2026 Pay Day';
const OCT = 'October 25, 2026 Pay Day';
const TITLES = ['Overview', SEPT, OCT];
const WIDTHS = { Overview: 5, [SEPT]: 39, [OCT]: 38 };

const sqls = () => db.query.mock.calls.map((c) => c[0]);

/** Routes db.query by SQL so the engine's parallel loads need no ordering. */
const primeDb = ({ link = linkRow(), year = { start_date: '2026-09-01' } } = {}) => {
  db.query.mockImplementation((sql) => {
    if (/FROM staff_hours_sheet_links/.test(sql)) return Promise.resolve({ rows: link ? [link] : [] });
    if (/FROM school_years/.test(sql)) return Promise.resolve({ rows: year ? [year] : [] });
    return Promise.resolve({ rows: [linkRow()], rowCount: 1 });
  });
};

beforeEach(() => {
  db._reset();
  assembly.loadPaySchedule.mockResolvedValue(schedule);
  assembly.buildPayPeriods.mockResolvedValue(builtPeriods());
  googleAuth.getAuthorizedClient.mockResolvedValue({ mockAuth: true });
  sheetsClient.ensureTabs.mockImplementation(async (auth, id, wanted) =>
    new Map(wanted.map((w, i) => [w.title, { sheetId: i + 1, title: w.title }])));
  sheetsClient.readGrids.mockImplementation(async (auth, { tabs }) => tabs.map(() => []));
  sheetsClient.applyMultiTabPlan.mockResolvedValue({ writes: 3 });
  sheetsClient.applyRequests.mockResolvedValue({ requests: 1 });
});

describe('staffHoursSyncEngine.syncStaffHours', () => {
  it('does nothing for a school with no linked sheet', async () => {
    primeDb({ link: null });
    await expect(syncStaffHours(SCHOOL)).resolves.toEqual({ synced: false, reason: 'not_linked' });
    expect(googleAuth.getAuthorizedClient).not.toHaveBeenCalled();
  });

  it('records why it cannot lay the sheet out when there is no pay schedule, without retrying', async () => {
    primeDb();
    assembly.loadPaySchedule.mockResolvedValue(null);

    await expect(syncStaffHours(SCHOOL)).resolves.toEqual({ synced: false, reason: 'not_configured' });

    const errCall = db.query.mock.calls.find(([sql]) => /last_error = \$2/.test(sql));
    expect(errCall[1]).toEqual([SCHOOL, NOT_CONFIGURED]);
    expect(googleAuth.getAuthorizedClient).not.toHaveBeenCalled();
  });

  it('needs an active school year to know where the tabs start', async () => {
    primeDb({ year: null });
    await expect(syncStaffHours(SCHOOL)).resolves.toEqual({ synced: false, reason: 'not_configured' });
  });

  it('lays out the year from the school year start, with the Overview pinned first', async () => {
    primeDb();
    const res = await syncStaffHours(SCHOOL);

    expect(res).toMatchObject({ synced: true, tabs: 3 });
    expect(assembly.buildPayPeriods).toHaveBeenCalledWith(
      layout.periodsForYear(schedule, '2026-09-01', '2026-09-26'), SCHOOL,
    );
    expect(sheetsClient.ensureTabs).toHaveBeenCalledWith(
      { mockAuth: true }, 'ss-1',
      [
        { title: 'Overview', legacyTitles: [] },
        { title: SEPT, legacyTitles: ['Pay day 2026-09-25'] },
        { title: OCT, legacyTitles: ['Pay day 2026-10-25'] },
      ],
      { pinFirst: ['Overview'] },
    );
  });

  it('reads every tab once and writes every tab once', async () => {
    primeDb();
    await syncStaffHours(SCHOOL);

    expect(sheetsClient.readGrids).toHaveBeenCalledTimes(1);
    expect(sheetsClient.readGrids.mock.calls[0][1]).toEqual({
      spreadsheetId: 'ss-1',
      tabs: TITLES.map((t) => ({ tabName: t, width: WIDTHS[t] })),
    });

    expect(sheetsClient.applyMultiTabPlan).toHaveBeenCalledTimes(1);
    const { tabPlans } = sheetsClient.applyMultiTabPlan.mock.calls[0][1];
    expect(tabPlans.map((p) => p.tabName)).toEqual(TITLES);
    expect(tabPlans.map((p) => p.sheetTabId)).toEqual([1, 2, 3]);
    // Fresh tabs: header rows + one staff row + Total appended on each.
    expect(tabPlans[1].plan.headerWrites).toHaveLength(2);
    expect(tabPlans[1].plan.appends).toHaveLength(2);
  });

  it('stamps last_synced_at with the width of every tab', async () => {
    primeDb();
    await syncStaffHours(SCHOOL);

    const call = db.query.mock.calls.find(([sql]) => /last_synced_at = now\(\)/.test(sql));
    expect(call[1][0]).toBe(SCHOOL);
    expect(JSON.parse(call[1][1])).toEqual(WIDTHS);
  });

  it('formats every tab after the values land: frozen names, headers, a colour per person', async () => {
    primeDb();
    const order = [];
    sheetsClient.applyMultiTabPlan.mockImplementation(async () => { order.push('values'); return { writes: 3 }; });
    sheetsClient.applyRequests.mockImplementation(async () => { order.push('format'); return { requests: 1 }; });

    await syncStaffHours(SCHOOL);

    expect(order).toEqual(['values', 'format']);
    const requests = sheetsClient.applyRequests.mock.calls[0][2];
    const frozen = requests.filter((r) => r.updateSheetProperties);
    expect(frozen.map((r) => r.updateSheetProperties.properties.sheetId)).toEqual([1, 2, 3]);
    expect(frozen[1].updateSheetProperties.properties.gridProperties).toEqual({ frozenRowCount: 2, frozenColumnCount: 2 });
    // The staff row is coloured on every tab, at the row the plan put it on.
    const coloured = requests.filter((r) => r.repeatCell && r.repeatCell.range.startRowIndex === 2 && r.repeatCell.range.sheetId === 2);
    expect(coloured).toHaveLength(1);
  });

  it('still formats when the values are already correct', async () => {
    primeDb({ link: linkRow({ tab_widths: WIDTHS }) });
    const built = builtPeriods();
    const tabs = [layout.buildOverviewTab(built), ...built.map(layout.buildPeriodTab)];
    sheetsClient.readGrids.mockResolvedValue(tabs.map((t) => [...t.headerRows, ...t.rows.map((r) => r.values.map(String))]));

    await syncStaffHours(SCHOOL);
    expect(sheetsClient.applyMultiTabPlan).not.toHaveBeenCalled();
    expect(sheetsClient.applyRequests).toHaveBeenCalledTimes(1);
  });

  it('carries a renamed tab\'s stored width over from its legacy title', async () => {
    primeDb({ link: linkRow({ tab_widths: { 'Pay day 2026-09-25': 45 } }) });
    await syncStaffHours(SCHOOL);

    const read = sheetsClient.readGrids.mock.calls[0][1].tabs.find((t) => t.tabName === SEPT);
    expect(read.width).toBe(45);
    const stamped = db.query.mock.calls.find(([sql]) => /last_synced_at = now\(\)/.test(sql));
    expect(JSON.parse(stamped[1][1])[SEPT]).toBe(45);
  });

  it('reads at the widest block it ever wrote, so a shrunken period blanks its stale cells', async () => {
    primeDb({ link: linkRow({ tab_widths: { [SEPT]: 45 } }) });
    await syncStaffHours(SCHOOL);

    const read = sheetsClient.readGrids.mock.calls[0][1].tabs.find((t) => t.tabName === SEPT);
    expect(read.width).toBe(45);
    const { tabPlans } = sheetsClient.applyMultiTabPlan.mock.calls[0][1];
    expect(tabPlans[1].plan.ownedColumns).toBe(45);
    expect(tabPlans[1].plan.appends[0]).toHaveLength(45);
  });

  it('inserts a column on the Overview when a new pay period begins, protecting the school\'s columns', async () => {
    // Last sync knew one period (width 4); now there are two (width 5).
    primeDb({ link: linkRow({ tab_widths: { Overview: 4 } }) });
    await syncStaffHours(SCHOOL);

    const { tabPlans } = sheetsClient.applyMultiTabPlan.mock.calls[0][1];
    expect(tabPlans[0].tabName).toBe('Overview');
    expect(tabPlans[0].plan.insertColumns).toBe(1);
  });

  it('skips the write entirely when every tab already matches', async () => {
    primeDb({ link: linkRow({ tab_widths: WIDTHS }) });
    // Feed back exactly what the layout would produce, as strings the way Sheets returns them.
    const built = builtPeriods();
    const tabs = [layout.buildOverviewTab(built), ...built.map(layout.buildPeriodTab)];
    sheetsClient.readGrids.mockResolvedValue(tabs.map((t) => [
      ...t.headerRows, ...t.rows.map((r) => r.values.map((v) => String(v))),
    ]));

    const res = await syncStaffHours(SCHOOL);
    expect(res).toMatchObject({ synced: true, updates: 0, appends: 0 });
    expect(sheetsClient.applyMultiTabPlan).not.toHaveBeenCalled();
    expect(sqls().some((s) => /last_synced_at = now\(\)/.test(s))).toBe(true);
  });

  it('records the error and rethrows when Google fails', async () => {
    primeDb();
    sheetsClient.readGrids.mockRejectedValueOnce(new Error('Google 503'));

    await expect(syncStaffHours(SCHOOL)).rejects.toThrow('Google 503');

    const errCall = db.query.mock.calls.find(([sql]) => /last_error = \$2/.test(sql));
    expect(errCall[1][1]).toMatch(/Google 503/);
    expect(sqls().some((s) => /last_synced_at = now\(\)/.test(s))).toBe(false);
  });

  it('propagates NeedsReconnectError so the worker can stop retrying', async () => {
    primeDb();
    googleAuth.getAuthorizedClient.mockRejectedValueOnce(new googleAuth.NeedsReconnectError());
    await expect(syncStaffHours(SCHOOL)).rejects.toThrow(googleAuth.NeedsReconnectError);
  });
});
