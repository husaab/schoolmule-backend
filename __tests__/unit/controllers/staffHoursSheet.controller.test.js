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
  getFileName: jest.fn(),
}));

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, mockTeacherUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const { mockQueryResponse } = require('../../helpers/mockDb');
const db = require('../../__mocks__/config/database');
const googleAuth = require('../../../services/google/googleAuth');
const sheetsClient = require('../../../services/google/sheetsClient');

const app = getApp();
const URL = '/api/teacher-attendance/sheet';

const connRow = (over = {}) => ({
  connection_id: 'c1', school: TEST_SCHOOL, google_email: 'admin@school.ca',
  refresh_token: 'enc', status: 'active', connected_at: '2026-09-01T00:00:00Z', ...over,
});
const linkRow = (over = {}) => ({
  link_id: 'l1', school: TEST_SCHOOL, spreadsheet_id: 'ss-1', spreadsheet_name: 'Staff hours',
  tab_widths: {}, last_synced_at: null, last_error: null, ...over,
});

describe('Staff Hours Sheet Controller', () => {
  describe('GET /sheet', () => {
    it('is admin-only', async () => {
      const res = await request(app).get(URL).set('Authorization', `Bearer ${mockTeacherUser()}`);
      expect(res.status).toBe(403);
    });

    it('reports an unlinked school with its connection state', async () => {
      mockQueryResponse([]);           // link
      mockQueryResponse([connRow()]);  // connection
      mockQueryResponse([]);           // job
      const res = await request(app).get(URL).set('Authorization', `Bearer ${mockAdminUser()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        linked: false, pendingSync: false, jobError: null,
        connection: { connected: true, googleEmail: 'admin@school.ca' },
      });
      expect(JSON.stringify(res.body)).not.toContain('enc');
    });

    it('reports a linked sheet and a queued sync', async () => {
      mockQueryResponse([linkRow({ last_synced_at: '2026-09-26T12:00:00Z' })]);
      mockQueryResponse([connRow()]);
      mockQueryResponse([{ job_id: 'j1', state: 'pending', last_error: null }]);
      const res = await request(app).get(URL).set('Authorization', `Bearer ${mockAdminUser()}`);
      expect(res.body.data).toMatchObject({
        linked: true, spreadsheetId: 'ss-1', spreadsheetName: 'Staff hours', pendingSync: true,
      });
    });

    it('surfaces a job that gave up', async () => {
      mockQueryResponse([linkRow()]);
      mockQueryResponse([connRow()]);
      mockQueryResponse([{ job_id: 'j1', state: 'failed', last_error: 'Google 503' }]);
      const res = await request(app).get(URL).set('Authorization', `Bearer ${mockAdminUser()}`);
      expect(res.body.data).toMatchObject({ pendingSync: false, jobError: 'Google 503' });
    });
  });

  describe('PUT /sheet', () => {
    it('asks the admin to connect Google first', async () => {
      googleAuth.getAuthorizedClient.mockRejectedValueOnce(new googleAuth.NeedsReconnectError());
      const res = await request(app).put(URL).set('Authorization', `Bearer ${mockAdminUser()}`).send({ spreadsheetId: 'ss-1' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('NEEDS_RECONNECT');
    });

    it('links a picked spreadsheet and queues the first sync', async () => {
      googleAuth.getAuthorizedClient.mockResolvedValueOnce({ mockAuth: true });
      sheetsClient.getFileName.mockResolvedValueOnce('Payroll 2026');
      mockQueryResponse([linkRow({ spreadsheet_name: 'Payroll 2026' })]); // upsert
      mockQueryResponse([{ job_id: 'j1' }]);                               // enqueue

      const res = await request(app).put(URL).set('Authorization', `Bearer ${mockAdminUser()}`).send({ spreadsheetId: 'ss-1' });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ linked: true, spreadsheetId: 'ss-1', spreadsheetName: 'Payroll 2026' });
      const upsert = db.query.mock.calls.find(([sql]) => /INSERT INTO staff_hours_sheet_links/.test(sql));
      expect(upsert[1].slice(0, 3)).toEqual([TEST_SCHOOL, 'ss-1', 'Payroll 2026']);
      expect(db.query.mock.calls.some(([sql]) => /INSERT INTO sheet_sync_jobs \(kind, school\)/.test(sql))).toBe(true);
    });

    it('creates a spreadsheet whose first tab is the Overview', async () => {
      googleAuth.getAuthorizedClient.mockResolvedValueOnce({ mockAuth: true });
      sheetsClient.createSpreadsheet.mockResolvedValueOnce({ spreadsheetId: 'new-1', title: 'ALHAADIACADEMY — Staff hours' });
      mockQueryResponse([linkRow({ spreadsheet_id: 'new-1' })]);
      mockQueryResponse([{ job_id: 'j1' }]);

      const res = await request(app).put(URL).set('Authorization', `Bearer ${mockAdminUser()}`).send({ createNew: true });

      expect(res.status).toBe(200);
      expect(sheetsClient.createSpreadsheet).toHaveBeenCalledWith(
        { mockAuth: true }, 'ALHAADIACADEMY — Staff hours', { firstTabTitle: 'Overview' },
      );
      expect(res.body.data.spreadsheetId).toBe('new-1');
    });

    it('requires a spreadsheet when not creating one', async () => {
      googleAuth.getAuthorizedClient.mockResolvedValueOnce({ mockAuth: true });
      const res = await request(app).put(URL).set('Authorization', `Bearer ${mockAdminUser()}`).send({});
      expect(res.status).toBe(400);
    });

    it('is admin-only', async () => {
      const res = await request(app).put(URL).set('Authorization', `Bearer ${mockTeacherUser()}`).send({ createNew: true });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /sheet', () => {
    it('forgets the link without touching the spreadsheet', async () => {
      mockQueryResponse([{ link_id: 'l1' }]);
      const res = await request(app).delete(URL).set('Authorization', `Bearer ${mockAdminUser()}`);
      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/left untouched/);
    });

    it('404s when nothing is linked', async () => {
      mockQueryResponse([]);
      const res = await request(app).delete(URL).set('Authorization', `Bearer ${mockAdminUser()}`);
      expect(res.status).toBe(404);
    });
  });

  describe('POST /sheet/sync', () => {
    it('queues a sync', async () => {
      mockQueryResponse([linkRow()]);
      mockQueryResponse([{ job_id: 'j1' }]);
      const res = await request(app).post(`${URL}/sync`).set('Authorization', `Bearer ${mockAdminUser()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ queued: true });
    });

    it('refuses when no sheet is linked', async () => {
      mockQueryResponse([]);
      const res = await request(app).post(`${URL}/sync`).set('Authorization', `Bearer ${mockAdminUser()}`);
      expect(res.status).toBe(400);
    });
  });
});
