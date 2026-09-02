jest.mock('../../../../services/google/googleAuth', () => {
  class NeedsReconnectError extends Error {
    constructor(m = 'reconnect') { super(m); this.name = 'NeedsReconnectError'; this.needsReconnect = true; }
  }
  return { NeedsReconnectError, getAuthorizedClient: jest.fn() };
});
jest.mock('../../../../services/google/sheetsClient', () => ({
  readGrid: jest.fn(),
  applyPlan: jest.fn(),
}));

const db = require('../../../__mocks__/config/database');
const { mockQueryResponse } = require('../../../helpers/mockDb');
const googleAuth = require('../../../../services/google/googleAuth');
const sheetsClient = require('../../../../services/google/sheetsClient');
const { syncForm } = require('../../../../services/google/sheetSyncEngine');
const { columnLetter, rowRange } = jest.requireActual('../../../../services/google/sheetsClient');

const FORM = 'form-1';

const linkRow = (over = {}) => ({
  link_id: 'l1',
  form_id: FORM,
  school: 'ALHAADIACADEMY',
  spreadsheet_id: 'ss-1',
  sheet_tab_id: 42,
  sheet_tab_name: 'New Students',
  owned_columns: 5,
  ...over,
});

const fieldRows = [
  { field_id: 'f1', label: 'Name', sort_order: 0 },
  { field_id: 'f2', label: 'Grade', sort_order: 1 },
];

const submissionRows = [{
  submission_id: 's1',
  answers: { f1: 'Ahmad', f2: '2' },
  submitted_at: '2026-08-24T00:00:00Z',
  status: 'new',
  status_label: 'New',
}];

// db.query order in syncForm: link, then (fields, submissions) in parallel.
const primeLoads = (link = linkRow(), fields = fieldRows, subs = submissionRows) => {
  mockQueryResponse(link ? [link] : []);
  mockQueryResponse(fields);
  mockQueryResponse(subs);
};

describe('sheetSyncEngine.syncForm', () => {
  beforeEach(() => {
    googleAuth.getAuthorizedClient.mockResolvedValue({ mockAuth: true });
    sheetsClient.readGrid.mockResolvedValue([]);
    sheetsClient.applyPlan.mockResolvedValue({ writes: 1 });
  });

  it('does nothing for a form with no linked sheet', async () => {
    mockQueryResponse([]); // no link
    await expect(syncForm(FORM)).resolves.toEqual({ synced: false, reason: 'not_linked' });
    expect(sheetsClient.applyPlan).not.toHaveBeenCalled();
  });

  it('writes the header and appends rows into an empty tab', async () => {
    primeLoads();
    mockQueryResponse([linkRow()]); // updateLinkSynced

    const res = await syncForm(FORM);

    expect(res.synced).toBe(true);
    expect(res.appends).toBe(1);
    const plan = sheetsClient.applyPlan.mock.calls[0][1].plan;
    expect(plan.headerWrite.values).toEqual(['Submission ID', 'Submitted', 'Status', 'Name', 'Grade']);
    expect(plan.appends).toEqual([['s1', '2026-08-24', 'New', 'Ahmad', '2']]);
  });

  it('skips the write entirely when the sheet is already correct', async () => {
    sheetsClient.readGrid.mockResolvedValue([
      ['Submission ID', 'Submitted', 'Status', 'Name', 'Grade'],
      ['s1', '2026-08-24', 'New', 'Ahmad', '2'],
    ]);
    primeLoads();
    mockQueryResponse([linkRow()]);

    await syncForm(FORM);
    // A no-op plan must not burn a Sheets write against the quota.
    expect(sheetsClient.applyPlan).not.toHaveBeenCalled();
  });

  it('reads only the owned column width, never the school\'s columns', async () => {
    primeLoads();
    mockQueryResponse([linkRow()]);

    await syncForm(FORM);
    expect(sheetsClient.readGrid).toHaveBeenCalledWith(
      { mockAuth: true },
      { spreadsheetId: 'ss-1', tabName: 'New Students', width: 5 },
    );
  });

  it('stamps last_synced_at with the current owned width on success', async () => {
    primeLoads();
    mockQueryResponse([linkRow()]);

    await syncForm(FORM);
    const call = db.query.mock.calls.find(([sql]) => /last_synced_at = now\(\)/.test(sql));
    expect(call).toBeDefined();
    expect(call[1]).toEqual([FORM, 5]);
  });

  it('records the error and rethrows when Google fails', async () => {
    primeLoads();
    mockQueryResponse([linkRow()]); // updateLinkError
    sheetsClient.readGrid.mockRejectedValueOnce(new Error('Google 503'));

    await expect(syncForm(FORM)).rejects.toThrow('Google 503');

    const errCall = db.query.mock.calls.find(([sql]) => /last_error = \$2/.test(sql));
    expect(errCall[1][1]).toMatch(/Google 503/);
    // A failed sync must not claim to have synced.
    expect(db.query.mock.calls.some(([sql]) => /last_synced_at = now\(\)/.test(sql))).toBe(false);
  });

  it('propagates NeedsReconnectError so the worker can stop retrying', async () => {
    primeLoads();
    mockQueryResponse([linkRow()]);
    googleAuth.getAuthorizedClient.mockRejectedValueOnce(new googleAuth.NeedsReconnectError());

    await expect(syncForm(FORM)).rejects.toThrow(googleAuth.NeedsReconnectError);
  });

  it('widens the block when the form gained a field', async () => {
    sheetsClient.readGrid.mockResolvedValue([['Submission ID', 'Submitted', 'Status', 'Name']]);
    primeLoads();
    mockQueryResponse([linkRow()]);

    await syncForm(FORM);
    const plan = sheetsClient.applyPlan.mock.calls[0][1].plan;
    expect(plan.insertColumns).toBe(1);
    expect(plan.ownedColumns).toBe(5);
  });
});

describe('sheetsClient A1 ranges', () => {
  it('maps column indices to letters, including past Z', () => {
    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(4)).toBe('E');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
  });

  it('bounds a row range to the owned width, which is what protects their columns', () => {
    expect(rowRange('Tab', 0, 5)).toBe("'Tab'!A1:E1");
    expect(rowRange('Tab', 9, 3)).toBe("'Tab'!A10:C10");
  });

  it('escapes a quote in the tab name', () => {
    expect(rowRange("Bob's Tab", 0, 2)).toBe("'Bob''s Tab'!A1:B1");
  });
});
