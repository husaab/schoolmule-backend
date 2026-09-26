const mockSpreadsheets = {
  get: jest.fn(),
  create: jest.fn(),
  batchUpdate: jest.fn(),
  values: { get: jest.fn(), batchGet: jest.fn(), batchUpdate: jest.fn() },
};
jest.mock('googleapis', () => ({
  google: { sheets: () => ({ spreadsheets: mockSpreadsheets }), drive: () => ({ files: { get: jest.fn() } }) },
}));

const sheetsClient = require('../../../../services/google/sheetsClient');

const auth = { mockAuth: true };

beforeEach(() => {
  Object.values(mockSpreadsheets).forEach((fn) => typeof fn.mockReset === 'function' && fn.mockReset());
  Object.values(mockSpreadsheets.values).forEach((fn) => fn.mockReset());
});

describe('ensureTabs', () => {
  it('creates only the missing tabs in one batch, pinning the overview first', async () => {
    mockSpreadsheets.get.mockResolvedValue({ data: { properties: { title: 'Hours' }, sheets: [
      { properties: { sheetId: 1, title: 'Pay day 2026-09-25' } },
    ] } });
    mockSpreadsheets.batchUpdate.mockResolvedValue({ data: { replies: [
      { addSheet: { properties: { sheetId: 7, title: 'Overview' } } },
      { addSheet: { properties: { sheetId: 8, title: 'Pay day 2026-10-25' } } },
    ] } });

    const tabs = await sheetsClient.ensureTabs(auth, 'ss-1', ['Overview', 'Pay day 2026-09-25', 'Pay day 2026-10-25'], { pinFirst: ['Overview'] });

    expect(mockSpreadsheets.batchUpdate).toHaveBeenCalledTimes(1);
    expect(mockSpreadsheets.batchUpdate.mock.calls[0][0].requestBody.requests).toEqual([
      { addSheet: { properties: { title: 'Overview', index: 0 } } },
      { addSheet: { properties: { title: 'Pay day 2026-10-25' } } },
    ]);
    expect(tabs.get('Overview')).toEqual({ sheetId: 7, title: 'Overview' });
    expect(tabs.get('Pay day 2026-09-25')).toEqual({ sheetId: 1, title: 'Pay day 2026-09-25' });
    expect(tabs.get('Pay day 2026-10-25')).toEqual({ sheetId: 8, title: 'Pay day 2026-10-25' });
  });

  it('makes no write when every tab already exists', async () => {
    mockSpreadsheets.get.mockResolvedValue({ data: { sheets: [{ properties: { sheetId: 7, title: 'Overview' } }] } });
    await sheetsClient.ensureTabs(auth, 'ss-1', ['Overview']);
    expect(mockSpreadsheets.batchUpdate).not.toHaveBeenCalled();
  });
});

describe('readGrids', () => {
  it('reads every tab\'s owned block in one call and returns [] for empty tabs', async () => {
    mockSpreadsheets.values.batchGet.mockResolvedValue({ data: { valueRanges: [
      { values: [['Staff ID', 'Staff member']] },
      {}, // an empty tab comes back with no values
    ] } });

    const grids = await sheetsClient.readGrids(auth, { spreadsheetId: 'ss-1', tabs: [
      { tabName: 'Overview', width: 5 },
      { tabName: "Pay day 2026-09-25", width: 39 },
    ] });

    expect(mockSpreadsheets.values.batchGet).toHaveBeenCalledWith(expect.objectContaining({
      ranges: ["'Overview'!A:E", "'Pay day 2026-09-25'!A:AM"],
    }));
    expect(grids).toEqual([[['Staff ID', 'Staff member']], []]);
  });
});

describe('applyMultiTabPlan', () => {
  const plan = (over = {}) => ({
    insertColumns: 0, headerWrites: [], updates: [], appends: [], appendStartRow: 1, ownedColumns: 3, ...over,
  });

  it('merges every tab\'s writes into one values.batchUpdate', async () => {
    mockSpreadsheets.values.batchUpdate.mockResolvedValue({});
    const res = await sheetsClient.applyMultiTabPlan(auth, { spreadsheetId: 'ss-1', tabPlans: [
      { sheetTabId: 1, tabName: 'Overview', plan: plan({ headerWrites: [{ rowIndex: 0, values: ['a', 'b', 'c'] }] }) },
      { sheetTabId: 2, tabName: 'Pay day 2026-09-25', plan: plan({ appends: [['t1', 'x', 1]], appendStartRow: 2 }) },
    ] });

    expect(mockSpreadsheets.batchUpdate).not.toHaveBeenCalled(); // no column inserts needed
    expect(mockSpreadsheets.values.batchUpdate).toHaveBeenCalledTimes(1);
    expect(mockSpreadsheets.values.batchUpdate.mock.calls[0][0].requestBody.data).toEqual([
      { range: "'Overview'!A1:C1", values: [['a', 'b', 'c']] },
      { range: "'Pay day 2026-09-25'!A3:C3", values: [['t1', 'x', 1]] },
    ]);
    expect(res).toEqual({ writes: 2 });
  });

  it('inserts columns before any value is written', async () => {
    const order = [];
    mockSpreadsheets.batchUpdate.mockImplementation(async () => { order.push('insert'); return {}; });
    mockSpreadsheets.values.batchUpdate.mockImplementation(async () => { order.push('values'); return {}; });

    await sheetsClient.applyMultiTabPlan(auth, { spreadsheetId: 'ss-1', tabPlans: [
      { sheetTabId: 1, tabName: 'Overview', plan: plan({ insertColumns: 1, ownedColumns: 4, updates: [{ rowIndex: 1, values: ['t1', 'x', 1, 1] }] }) },
    ] });

    expect(order).toEqual(['insert', 'values']);
    expect(mockSpreadsheets.batchUpdate.mock.calls[0][0].requestBody.requests[0].insertDimension.range)
      .toEqual({ sheetId: 1, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 });
  });

  it('still understands a single-tab plan with the old headerWrite shape', async () => {
    mockSpreadsheets.values.batchUpdate.mockResolvedValue({});
    await sheetsClient.applyPlan(auth, { spreadsheetId: 'ss-1', sheetTabId: 1, tabName: 'T', plan: {
      insertColumns: 0, headerWrite: { rowIndex: 0, values: ['a', 'b', 'c'] }, updates: [], appends: [], appendStartRow: 1, ownedColumns: 3,
    } });
    expect(mockSpreadsheets.values.batchUpdate.mock.calls[0][0].requestBody.data)
      .toEqual([{ range: "'T'!A1:C1", values: [['a', 'b', 'c']] }]);
  });
});

describe('sharing', () => {
  const mockPermissions = { list: jest.fn(), create: jest.fn(), delete: jest.fn() };
  const { google } = require('googleapis');
  beforeEach(() => {
    Object.values(mockPermissions).forEach((fn) => fn.mockReset());
    google.drive = () => ({ permissions: mockPermissions });
  });

  it('lists permissions in our shape', async () => {
    mockPermissions.list.mockResolvedValue({ data: { permissions: [
      { id: 'p1', type: 'user', role: 'owner', emailAddress: 'a@b.ca', displayName: 'A' },
      { id: 'p2', type: 'anyone', role: 'reader' },
    ] } });
    await expect(sheetsClient.listPermissions(auth, 'ss-1')).resolves.toEqual([
      { id: 'p1', type: 'user', role: 'owner', email: 'a@b.ca', displayName: 'A' },
      { id: 'p2', type: 'anyone', role: 'reader', email: null, displayName: null },
    ]);
  });

  it('shares with a person and lets Google send the notification', async () => {
    mockPermissions.create.mockResolvedValue({ data: { id: 'p3', type: 'user', role: 'writer', emailAddress: 'c@d.ca' } });
    const share = await sheetsClient.sharePermission(auth, 'ss-1', { email: 'c@d.ca', role: 'writer' });
    expect(mockPermissions.create).toHaveBeenCalledWith(expect.objectContaining({
      fileId: 'ss-1',
      sendNotificationEmail: true,
      requestBody: { type: 'user', role: 'writer', emailAddress: 'c@d.ca' },
    }));
    expect(share).toMatchObject({ id: 'p3', role: 'writer', email: 'c@d.ca' });
  });

  it('removes a permission by id', async () => {
    mockPermissions.delete.mockResolvedValue({});
    await sheetsClient.removePermission(auth, 'ss-1', 'p3');
    expect(mockPermissions.delete).toHaveBeenCalledWith({ fileId: 'ss-1', permissionId: 'p3' });
  });
});
