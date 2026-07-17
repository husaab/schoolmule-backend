const db = require('../../../config/database'); // mapped to the mock by jest.unit.config
const resolveSchoolYear = require('../../../middleware/resolveSchoolYear');

const YEAR_ID = '3f0e0a1c-2222-4444-8888-aaaaaaaaaaaa';
const activeRow = { school_year_id: YEAR_ID, school: 'ALHAADIACADEMY', label: '2025-2026', is_active: true };
const pastRow   = { school_year_id: YEAR_ID, school: 'ALHAADIACADEMY', label: '2024-2025', is_active: false };

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const makeReq = (over = {}) => ({
  headers: {}, method: 'GET',
  user: { school: 'ALHAADIACADEMY', role: 'ADMIN' },
  ...over,
});

describe('resolveSchoolYear', () => {
  beforeEach(() => jest.clearAllMocks());

  it('falls back to active year when no header', async () => {
    db.query.mockResolvedValueOnce({ rows: [activeRow] });
    const req = makeReq(); const next = jest.fn();
    await resolveSchoolYear(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(req.schoolYear).toEqual({ schoolYearId: YEAR_ID, label: '2025-2026', isActive: true });
  });

  it('rejects a malformed header with 400', async () => {
    const req = makeReq({ headers: { 'x-school-year': 'not-a-uuid' } });
    const res = makeRes();
    await resolveSchoolYear(req, res, jest.fn());
    expect(res.statusCode).toBe(400);
  });

  it('rejects a year belonging to another school with 403', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ...activeRow, school: 'PLAYGROUND' }] });
    const req = makeReq({ headers: { 'x-school-year': YEAR_ID } });
    const res = makeRes();
    await resolveSchoolYear(req, res, jest.fn());
    expect(res.statusCode).toBe(403);
  });

  it('blocks teacher writes to a non-active year with 403', async () => {
    db.query.mockResolvedValueOnce({ rows: [pastRow] });
    const req = makeReq({ headers: { 'x-school-year': YEAR_ID }, method: 'POST',
                          user: { school: 'ALHAADIACADEMY', role: 'TEACHER' } });
    const res = makeRes();
    await resolveSchoolYear(req, res, jest.fn());
    expect(res.statusCode).toBe(403);
    expect(res.body.message).toMatch(/read-only/i);
  });

  it('allows admin writes to a non-active year', async () => {
    db.query.mockResolvedValueOnce({ rows: [pastRow] });
    const req = makeReq({ headers: { 'x-school-year': YEAR_ID }, method: 'PUT' });
    const next = jest.fn();
    await resolveSchoolYear(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(req.schoolYear.isActive).toBe(false);
  });

  it('passes through with null year and blocks writes when school has no years', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const req = makeReq({ user: { school: 'JCC', role: 'ADMIN' } });
    const next = jest.fn();
    await resolveSchoolYear(req, makeRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(req.schoolYear).toBeNull();

    db.query.mockResolvedValueOnce({ rows: [] });
    const res = makeRes();
    await resolveSchoolYear(makeReq({ method: 'POST', user: { school: 'JCC', role: 'ADMIN' } }), res, jest.fn());
    expect(res.statusCode).toBe(400);
  });
});
