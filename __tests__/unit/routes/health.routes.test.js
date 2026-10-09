const db = require('../../__mocks__/config/database');
const request = require('supertest');
const { getApp } = require('../../helpers/testApp');

describe('GET /api/health', () => {
  it('is public and reports db ok', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    const res = await request(getApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ ok: true, db: 'ok' }));
    expect(typeof res.body.uptime_s).toBe('number');
    expect(res.body.buffer).toEqual(expect.objectContaining({ pending: expect.any(Number) }));
  });
  it('returns 503 when the db check fails', async () => {
    db.query.mockRejectedValueOnce(new Error('down'));
    const res = await request(getApp()).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.db).toBe('down');
  });
});
