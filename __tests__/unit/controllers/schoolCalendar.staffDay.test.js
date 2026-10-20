// What a school closure means for staff (school_calendar_events.staff_day):
// accepted, defaulted and preserved by the calendar API.

const request = require('supertest');
const { getApp } = require('../../helpers/testApp');
const { mockAdminUser, TEST_SCHOOL } = require('../../helpers/mockAuth');
const db = require('../../__mocks__/config/database');

const app = getApp();
const url = '/api/calendar-events';
const EVENT_ID = '11111111-2222-4333-8444-555555555555';

const eventRow = (overrides = {}) => ({
  event_id: EVENT_ID,
  school: TEST_SCHOOL,
  school_id: null,
  title: 'PA Day',
  category: 'pa-day',
  start_date: '2026-11-20',
  end_date: null,
  is_school_closed: true,
  staff_day: 'work',
  notes: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...overrides,
});

const YEAR_ROW = { school_year_id: 'y1', school: TEST_SCHOOL, label: '2026-2027', start_date: '2026-09-07', end_date: '2027-06-25', is_active: true };

/** The params the controller sent with a query whose SQL matches `re`. */
const paramsFor = (re) => db.query.mock.calls.find(([sql]) => re.test(sql))?.[1];

beforeEach(() => db._reset());

describe('POST /api/calendar-events staffDay', () => {
  const prime = (row) => {
    db.query.mockImplementation((sql) => {
      if (/FROM school_years/.test(sql)) return Promise.resolve({ rows: [YEAR_ROW], rowCount: 1 });
      if (/INSERT INTO school_calendar_events/.test(sql)) return Promise.resolve({ rows: [row], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
  };

  it('stores the staff treatment it is given and returns it', async () => {
    prime(eventRow({ title: 'Eid Day', category: 'holiday', staff_day: 'paid' }));
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${mockAdminUser()}`)
      .send({ title: 'Eid Day', category: 'holiday', startDate: '2027-03-09', isSchoolClosed: true, staffDay: 'paid' });

    expect(res.status).toBe(201);
    expect(res.body.data.staffDay).toBe('paid');
    expect(paramsFor(/INSERT INTO school_calendar_events/)[9]).toBe('paid');
  });

  it('defaults a PA day to a staff work day and anything else to an unpaid day off', async () => {
    prime(eventRow());
    await request(app)
      .post(url)
      .set('Authorization', `Bearer ${mockAdminUser()}`)
      .send({ title: 'PA Day', category: 'pa-day', startDate: '2026-11-20', isSchoolClosed: true });
    expect(paramsFor(/INSERT INTO school_calendar_events/)[9]).toBe('work');

    db._reset();
    prime(eventRow({ category: 'holiday', staff_day: 'off' }));
    await request(app)
      .post(url)
      .set('Authorization', `Bearer ${mockAdminUser()}`)
      .send({ title: 'Easter Monday', category: 'holiday', startDate: '2027-03-29', isSchoolClosed: true });
    expect(paramsFor(/INSERT INTO school_calendar_events/)[9]).toBe('off');
  });

  it('rejects an unknown staff treatment', async () => {
    prime(eventRow());
    const res = await request(app)
      .post(url)
      .set('Authorization', `Bearer ${mockAdminUser()}`)
      .send({ title: 'X', startDate: '2026-11-20', isSchoolClosed: true, staffDay: 'sometimes' });
    expect(res.status).toBe(400);
    expect(paramsFor(/INSERT INTO school_calendar_events/)).toBeUndefined();
  });
});

describe('PATCH /api/calendar-events/:eventId staffDay', () => {
  const prime = (existing) => {
    db.query.mockImplementation((sql, params) => {
      if (/FROM school_years/.test(sql)) return Promise.resolve({ rows: [YEAR_ROW], rowCount: 1 });
      if (/WHERE e.event_id = \$1/.test(sql)) return Promise.resolve({ rows: [existing], rowCount: 1 });
      if (/UPDATE school_calendar_events/.test(sql)) {
        return Promise.resolve({ rows: [{ ...existing, staff_day: params[7] }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
  };

  it('changes the staff treatment', async () => {
    prime(eventRow({ title: 'Eid Day', category: 'holiday', staff_day: 'off' }));
    const res = await request(app)
      .patch(`${url}/${EVENT_ID}`)
      .set('Authorization', `Bearer ${mockAdminUser()}`)
      .send({ staffDay: 'paid' });
    expect(res.status).toBe(200);
    expect(res.body.data.staffDay).toBe('paid');
  });

  it('keeps the stored treatment when the request leaves it out', async () => {
    prime(eventRow({ staff_day: 'work' }));
    await request(app)
      .patch(`${url}/${EVENT_ID}`)
      .set('Authorization', `Bearer ${mockAdminUser()}`)
      .send({ title: 'PA Day (Math)' });
    expect(paramsFor(/UPDATE school_calendar_events/)[7]).toBe('work');
  });

  it('rejects an unknown staff treatment', async () => {
    prime(eventRow());
    const res = await request(app)
      .patch(`${url}/${EVENT_ID}`)
      .set('Authorization', `Bearer ${mockAdminUser()}`)
      .send({ staffDay: 'sometimes' });
    expect(res.status).toBe(400);
    expect(paramsFor(/UPDATE school_calendar_events/)).toBeUndefined();
  });
});
