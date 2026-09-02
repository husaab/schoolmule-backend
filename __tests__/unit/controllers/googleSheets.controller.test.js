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
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const db = require('../../__mocks__/config/database');
const googleAuth = require('../../../services/google/googleAuth');
const sheetsClient = require('../../../services/google/sheetsClient');
const { signState, verifyState } = require('../../../controllers/googleSheets.controller');

const app = getApp();
const FORM = '11111111-1111-4111-8111-111111111111';

const formRow = { form_id: FORM, school: 'ALHAADIACADEMY', title: 'New Students' };
const connRow = (over = {}) => ({
  connection_id: 'c1', school: 'ALHAADIACADEMY', google_email: 'admin@school.ca',
  refresh_token: 'enc', status: 'active', connected_at: '2026-09-01T00:00:00Z', ...over,
});
const linkRow = (over = {}) => ({
  link_id: 'l1', form_id: FORM, spreadsheet_id: 'ss-1', spreadsheet_name: 'Registrations',
  sheet_tab_id: 42, sheet_tab_name: 'New Students', owned_columns: 5,
  last_synced_at: null, last_error: null, ...over,
});

describe('OAuth state signing', () => {
  beforeAll(() => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'; });

  it('round-trips the school', () => {
    const state = signState({ school: 'ALHAADIACADEMY', userId: 'u1', iat: Date.now() });
    expect(verifyState(state).school).toBe('ALHAADIACADEMY');
  });

  it('rejects a tampered payload', () => {
    const [body, sig] = signState({ school: 'ALHAADIACADEMY', iat: Date.now() }).split('.');
    const forged = Buffer.from(JSON.stringify({ school: 'JCC', iat: Date.now() })).toString('base64url');
    // Swapping the school without a valid signature must not be accepted, or a
    // forged callback could attach a Google account to another tenant.
    expect(verifyState(`${forged}.${sig}`)).toBeNull();
    expect(verifyState(`${body}.deadbeef`)).toBeNull();
  });

  it('rejects a stale state', () => {
    const old = signState({ school: 'ALHAADIACADEMY', iat: Date.now() - 20 * 60 * 1000 });
    expect(verifyState(old)).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    expect(verifyState('')).toBeNull();
    expect(verifyState('garbage')).toBeNull();
    expect(verifyState(undefined)).toBeNull();
  });
});

describe('Google Sheets Controller', () => {
  describe('GET /google/status', () => {
    it('reports not connected when there is no connection', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);
      const res = await request(app).get('/api/registration/google/status')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ connected: false });
    });

    it('never returns the refresh token', async () => {
      const token = mockAdminUser();
      mockQueryResponse([connRow({ refresh_token: 'SUPER-SECRET' })]);
      const res = await request(app).get('/api/registration/google/status')
        .set('Authorization', `Bearer ${token}`);
      expect(JSON.stringify(res.body)).not.toContain('SUPER-SECRET');
      expect(res.body.data.googleEmail).toBe('admin@school.ca');
    });
  });

  describe('GET /google/auth-url', () => {
    it('returns a consent URL rather than redirecting', async () => {
      const token = mockAdminUser();
      const res = await request(app).get('/api/registration/google/auth-url')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.url).toMatch(/accounts\.google\.com/);
      // The school is baked into the signed state while we still know it.
      expect(verifyState(googleAuth.buildAuthUrl.mock.calls.at(-1)[0].nonce).school)
        .toBe('ALHAADIACADEMY');
    });
  });

  describe('PUT /forms/:formId/sheet', () => {
    const url = `/api/registration/forms/${FORM}/sheet`;

    it('returns 404 for a form belonging to another school', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]); // selectFormById is school-scoped and finds nothing
      const res = await request(app).put(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ spreadsheetId: 'ss-1' });
      expect(res.status).toBe(404);
    });

    it('asks the admin to connect Google first', async () => {
      const token = mockAdminUser();
      mockQueryResponse([formRow]);
      googleAuth.getAuthorizedClient.mockRejectedValueOnce(new googleAuth.NeedsReconnectError());

      const res = await request(app).put(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ spreadsheetId: 'ss-1' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NEEDS_RECONNECT');
    });

    it('links a picked spreadsheet into a tab named after the form', async () => {
      const token = mockAdminUser();
      mockQueryResponse([formRow]);
      googleAuth.getAuthorizedClient.mockResolvedValueOnce({ auth: true });
      sheetsClient.getFileName.mockResolvedValueOnce('Registrations');
      sheetsClient.addTab.mockResolvedValueOnce({ sheetId: 42, title: 'New Students' });
      mockQueryResponse([{ field_id: 'f1', label: 'Name' }]); // fields
      mockQueryResponse([linkRow()]);                          // upsertLink
      mockQueryResponse([{ job_id: 'j1' }]);                   // enqueueJob

      const res = await request(app).put(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ spreadsheetId: 'ss-1' });

      expect(res.status).toBe(200);
      expect(sheetsClient.addTab).toHaveBeenCalledWith({ auth: true }, 'ss-1', 'New Students');
      // Owned width is 3 fixed columns + 1 field.
      const upsertParams = db.query.mock.calls.find(([sql]) => /INSERT INTO form_sheet_links/.test(sql))[1];
      expect(upsertParams[5]).toBe(4);
    });

    it('creates a spreadsheet when asked', async () => {
      const token = mockAdminUser();
      mockQueryResponse([formRow]);
      googleAuth.getAuthorizedClient.mockResolvedValueOnce({ auth: true });
      sheetsClient.createSpreadsheet.mockResolvedValueOnce({
        spreadsheetId: 'new-ss', title: 'New Students — Submissions',
        firstTab: { sheetId: 0, title: 'Sheet1' },
      });
      sheetsClient.addTab.mockResolvedValueOnce({ sheetId: 7, title: 'New Students' });
      mockQueryResponse([]);                 // fields
      mockQueryResponse([linkRow()]);        // upsertLink
      mockQueryResponse([{ job_id: 'j1' }]); // enqueueJob

      const res = await request(app).put(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ createNew: true });

      expect(res.status).toBe(200);
      expect(sheetsClient.createSpreadsheet).toHaveBeenCalled();
      expect(sheetsClient.getFileName).not.toHaveBeenCalled();
    });

    it('queues an immediate sync so the sheet is not left empty', async () => {
      const token = mockAdminUser();
      mockQueryResponse([formRow]);
      googleAuth.getAuthorizedClient.mockResolvedValueOnce({ auth: true });
      sheetsClient.getFileName.mockResolvedValueOnce('Registrations');
      sheetsClient.addTab.mockResolvedValueOnce({ sheetId: 42, title: 'New Students' });
      mockQueryResponse([]);
      mockQueryResponse([linkRow()]);
      mockQueryResponse([{ job_id: 'j1' }]);

      await request(app).put(url).set('Authorization', `Bearer ${token}`).send({ spreadsheetId: 'ss-1' });
      expect(db.query.mock.calls.some(([sql]) => /INSERT INTO sheet_sync_jobs/.test(sql))).toBe(true);
    });

    it('requires a spreadsheet when not creating one', async () => {
      const token = mockAdminUser();
      mockQueryResponse([formRow]);
      googleAuth.getAuthorizedClient.mockResolvedValueOnce({ auth: true });

      const res = await request(app).put(url)
        .set('Authorization', `Bearer ${token}`).send({});
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /forms/:formId/sheet', () => {
    it('forgets the link without touching the spreadsheet', async () => {
      const token = mockAdminUser();
      mockQueryResponse([{ link_id: 'l1' }]);

      const res = await request(app).delete(`/api/registration/forms/${FORM}/sheet`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/left untouched/i);
      // No Google call at all — the sheet is the school's property.
      expect(sheetsClient.addTab).not.toHaveBeenCalled();
    });

    it('404s when nothing is linked', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);
      const res = await request(app).delete(`/api/registration/forms/${FORM}/sheet`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /forms/:formId/sheet/sync', () => {
    const url = `/api/registration/forms/${FORM}/sheet/sync`;

    it('queues a sync', async () => {
      const token = mockAdminUser();
      mockQueryResponse([formRow]);
      mockQueryResponse([linkRow()]);
      mockQueryResponse([{ job_id: 'j1' }]);

      const res = await request(app).post(url).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.queued).toBe(true);
    });

    it('refuses when no sheet is linked', async () => {
      const token = mockAdminUser();
      mockQueryResponse([formRow]);
      mockQueryResponse([]);
      const res = await request(app).post(url).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('404s for another school\'s form', async () => {
      const token = mockAdminUser();
      mockQueryResponse([]);
      const res = await request(app).post(url).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /google/callback (public)', () => {
    beforeEach(() => { process.env.FRONTEND_URL = 'https://schoolmule.ca'; });

    it('is reachable without a JWT, since Google sends the browser here', async () => {
      const res = await request(app).get('/api/registration/google/callback?error=access_denied');
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('google=denied');
    });

    it('refuses a callback with an unsigned state', async () => {
      const res = await request(app).get('/api/registration/google/callback?code=abc&state=forged');
      expect(res.headers.location).toContain('google=invalid_state');
      expect(googleAuth.exchangeCode).not.toHaveBeenCalled();
    });

    it('stores the connection against the school named in the signed state', async () => {
      const state = signState({ school: 'ALHAADIACADEMY', userId: 'u1', iat: Date.now() });
      googleAuth.exchangeCode.mockResolvedValueOnce({ refreshToken: 'rt', email: 'a@b.ca' });
      googleAuth.saveConnection.mockResolvedValueOnce({});

      const res = await request(app)
        .get(`/api/registration/google/callback?code=abc&state=${encodeURIComponent(state)}`);

      expect(googleAuth.saveConnection).toHaveBeenCalledWith(
        expect.objectContaining({ school: 'ALHAADIACADEMY', refreshToken: 'rt' }),
      );
      expect(res.headers.location).toContain('google=connected');
    });
  });
});
