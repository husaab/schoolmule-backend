jest.mock('../../../services/google/googleAuth', () => {
  class NeedsReconnectError extends Error {
    constructor(m = 'reconnect') { super(m); this.needsReconnect = true; }
  }
  return {
    NeedsReconnectError,
    buildAuthUrl: jest.fn(() => 'https://accounts.google.com/o/oauth2/auth?mock'),
    exchangeCode: jest.fn(),
    saveConnection: jest.fn(),
    getAuthorizedClient: jest.fn(),
  };
});
jest.mock('../../../services/google/sheetsClient', () => ({
  createSpreadsheet: jest.fn(),
  addTab: jest.fn(),
  getFileName: jest.fn(),
  listPermissions: jest.fn(),
  sharePermission: jest.fn(),
  removePermission: jest.fn(),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const googleAuth = require('../../../services/google/googleAuth');
const sheetsClient = require('../../../services/google/sheetsClient');

const app = getApp();
const FORM = '11111111-1111-4111-8111-111111111111';
const STAFF_URL = '/api/teacher-attendance/sheet/shares';
const FORM_URL = `/api/registration/forms/${FORM}/sheet/shares`;

const connRow = { connection_id: 'c1', school: TEST_SCHOOL, google_email: 'admin@school.ca', refresh_token: 'enc', status: 'active' };
const staffLink = { link_id: 'l1', school: TEST_SCHOOL, spreadsheet_id: 'ss-1' };
const formLink = { link_id: 'l2', form_id: FORM, spreadsheet_id: 'ss-2' };

const owner = { id: 'p-owner', type: 'user', role: 'owner', email: 'admin@school.ca', displayName: 'Admin' };
const viewer = { id: 'p-view', type: 'user', role: 'reader', email: 'payroll@school.ca', displayName: 'Payroll' };

/** Link lookup, then the connected-account lookup, in the order withSheet runs them. */
const primeStaff = () => { mockQueryResponse([staffLink]); mockQueryResponse([connRow]); };
const primeForm = () => { mockQueryResponse([formLink]); mockQueryResponse([connRow]); };

beforeEach(() => {
  googleAuth.getAuthorizedClient.mockResolvedValue({ mockAuth: true });
  sheetsClient.listPermissions.mockResolvedValue([owner, viewer]);
});

describe('Sheet sharing (staff hours)', () => {
  it('is admin-only', async () => {
    const res = await request(app).get(STAFF_URL).set('Authorization', `Bearer ${mockTeacherUser()}`);
    expect(res.status).toBe(403);
  });

  it('lists who the sheet is shared with, flagging the owner and the connected account', async () => {
    primeStaff();
    const res = await request(app).get(STAFF_URL).set('Authorization', `Bearer ${mockAdminUser()}`);
    expect(res.status).toBe(200);
    expect(sheetsClient.listPermissions).toHaveBeenCalledWith({ mockAuth: true }, 'ss-1');
    expect(res.body.data.shares).toEqual([
      { ...owner, isOwner: true, isConnectedAccount: true },
      { ...viewer, isOwner: false, isConnectedAccount: false },
    ]);
  });

  it('404s when nothing is linked', async () => {
    mockQueryResponse([]);
    const res = await request(app).get(STAFF_URL).set('Authorization', `Bearer ${mockAdminUser()}`);
    expect(res.status).toBe(404);
  });

  it('asks the admin to connect Google first', async () => {
    primeStaff();
    googleAuth.getAuthorizedClient.mockRejectedValueOnce(new googleAuth.NeedsReconnectError());
    const res = await request(app).get(STAFF_URL).set('Authorization', `Bearer ${mockAdminUser()}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NEEDS_RECONNECT');
  });

  it('shares with a new person as an editor by default', async () => {
    primeStaff();
    sheetsClient.sharePermission.mockResolvedValueOnce({ id: 'p-new', type: 'user', role: 'writer', email: 'bursar@school.ca', displayName: null });
    const res = await request(app).post(STAFF_URL).set('Authorization', `Bearer ${mockAdminUser()}`)
      .send({ email: '  Bursar@School.ca ' });
    expect(res.status).toBe(200);
    expect(sheetsClient.sharePermission).toHaveBeenCalledWith({ mockAuth: true }, 'ss-1', { email: 'bursar@school.ca', role: 'writer' });
    expect(res.body.data.share).toMatchObject({ id: 'p-new', role: 'writer', isOwner: false, isConnectedAccount: false });
  });

  it('accepts viewer as a role', async () => {
    primeStaff();
    sheetsClient.sharePermission.mockResolvedValueOnce({ id: 'p-new', type: 'user', role: 'reader', email: 'a@b.ca' });
    const res = await request(app).post(STAFF_URL).set('Authorization', `Bearer ${mockAdminUser()}`)
      .send({ email: 'a@b.ca', role: 'reader' });
    expect(res.status).toBe(200);
    expect(sheetsClient.sharePermission.mock.calls[0][2].role).toBe('reader');
  });

  it('rejects a bad email or role before touching Google', async () => {
    let res = await request(app).post(STAFF_URL).set('Authorization', `Bearer ${mockAdminUser()}`).send({ email: 'nope' });
    expect(res.status).toBe(400);
    res = await request(app).post(STAFF_URL).set('Authorization', `Bearer ${mockAdminUser()}`).send({ email: 'a@b.ca', role: 'owner' });
    expect(res.status).toBe(400);
    expect(sheetsClient.sharePermission).not.toHaveBeenCalled();
  });

  it("explains when the connected account can't share the file", async () => {
    primeStaff();
    sheetsClient.sharePermission.mockRejectedValueOnce(Object.assign(new Error('insufficientFilePermissions'), { code: 403 }));
    const res = await request(app).post(STAFF_URL).set('Authorization', `Bearer ${mockAdminUser()}`).send({ email: 'a@b.ca' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/owner or an editor/);
  });

  it('removes a share', async () => {
    primeStaff();
    sheetsClient.removePermission.mockResolvedValueOnce();
    const res = await request(app).delete(`${STAFF_URL}/p-view`).set('Authorization', `Bearer ${mockAdminUser()}`);
    expect(res.status).toBe(200);
    expect(sheetsClient.removePermission).toHaveBeenCalledWith({ mockAuth: true }, 'ss-1', 'p-view');
  });

  it('refuses to remove the owner or the connected account', async () => {
    primeStaff();
    let res = await request(app).delete(`${STAFF_URL}/p-owner`).set('Authorization', `Bearer ${mockAdminUser()}`);
    expect(res.status).toBe(400);

    primeStaff();
    sheetsClient.listPermissions.mockResolvedValueOnce([{ id: 'p-conn', type: 'user', role: 'writer', email: 'Admin@School.ca' }]);
    res = await request(app).delete(`${STAFF_URL}/p-conn`).set('Authorization', `Bearer ${mockAdminUser()}`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/stop the sync/);
    expect(sheetsClient.removePermission).not.toHaveBeenCalled();
  });

  it('404s when the permission is already gone', async () => {
    primeStaff();
    const res = await request(app).delete(`${STAFF_URL}/p-gone`).set('Authorization', `Bearer ${mockAdminUser()}`);
    expect(res.status).toBe(404);
  });
});

describe('Sheet sharing (registration form)', () => {
  it('is admin-only, unlike the rest of the registration router', async () => {
    const res = await request(app).post(FORM_URL).set('Authorization', `Bearer ${mockTeacherUser()}`).send({ email: 'a@b.ca' });
    expect(res.status).toBe(403);
    expect(sheetsClient.sharePermission).not.toHaveBeenCalled();
  });

  it('resolves the spreadsheet through the form link', async () => {
    primeForm();
    const res = await request(app).get(FORM_URL).set('Authorization', `Bearer ${mockAdminUser()}`);
    expect(res.status).toBe(200);
    expect(sheetsClient.listPermissions).toHaveBeenCalledWith({ mockAuth: true }, 'ss-2');
  });

  it('404s for a form with no linked sheet (or another school\'s form)', async () => {
    mockQueryResponse([]);
    const res = await request(app).post(FORM_URL).set('Authorization', `Bearer ${mockAdminUser()}`).send({ email: 'a@b.ca' });
    expect(res.status).toBe(404);
  });
});
