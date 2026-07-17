// Mock database module - replaces config/database.js in unit tests
// Prevents testConnection() from running at module load

// The resolveSchoolYear middleware is now mounted globally in server.js,
// so *every* unit test that exercises a route through the app (via
// __tests__/helpers/testApp.js) triggers one extra db.query call before the
// controller under test ever runs: the middleware's "no X-School-Year header
// -> look up the school's active year" fallback query.
//
// The vast majority of existing/unrelated unit tests pre-queue
// db.query.mockResolvedValueOnce(...)/mockRejectedValueOnce(...) responses,
// in order, for their OWN controller's queries — with no idea this extra
// call now happens first. To avoid having to touch every one of those test
// files, db.query inspects the SQL text: any query against `school_years`
// is answered from a default active-year row WITHOUT consuming a slot from
// the general response queue, unless a test explicitly registers an
// override via mockSchoolYearsResponseOnce/mockSchoolYearsRejectionOnce
// (see middleware/resolveSchoolYear.test.js, which controls this query
// directly and needs precise responses per test).

const DEFAULT_SCHOOL_YEAR_ID = '99999999-9999-4999-8999-999999999999';

function isSchoolYearsQuery(sql) {
  return typeof sql === 'string' && sql.includes('FROM school_years');
}

function defaultSchoolYearRow(params) {
  const school = Array.isArray(params) && typeof params[0] === 'string' ? params[0] : 'ALHAADIACADEMY';
  return {
    rows: [{
      school_year_id: DEFAULT_SCHOOL_YEAR_ID,
      school,
      school_id: null,
      label: '2025-2026',
      start_date: '2025-09-01',
      end_date: '2026-06-30',
      is_active: true,
      created_from_year_id: null,
    }],
  };
}

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

// Manually-managed FIFO queues standing in for jest's own "Once" queue.
// We manage these ourselves (rather than relying on jest's built-in
// mockResolvedValueOnce/mockImplementationOnce) so the base implementation
// below can special-case "FROM school_years" calls BEFORE ever touching the
// general queue — jest's native once-queue has no such SQL-awareness and
// would otherwise hand the middleware's call a value a test queued for its
// own controller query, shifting everything else out of order.
let responseQueue = [];
let schoolYearsQueue = [];

function runNext(entry, sql, params) {
  if (entry.type === 'reject') return Promise.reject(entry.value);
  if (entry.type === 'impl') return Promise.resolve(entry.value(sql, params));
  return Promise.resolve(entry.value);
}

function baseImplementation(sql, params) {
  if (isSchoolYearsQuery(sql)) {
    if (schoolYearsQueue.length > 0) {
      return runNext(schoolYearsQueue.shift(), sql, params);
    }
    return Promise.resolve(defaultSchoolYearRow(params));
  }
  if (responseQueue.length > 0) {
    return runNext(responseQueue.shift(), sql, params);
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

const query = jest.fn(baseImplementation);

// Route the standard jest "Once" API through our own queue instead of
// jest's internal one (see comment above) — existing test code
// (db.query.mockResolvedValueOnce/mockRejectedValueOnce) keeps working
// unchanged for every query EXCEPT one matching "FROM school_years".
query.mockResolvedValueOnce = (value) => {
  responseQueue.push({ type: 'resolve', value });
  return query;
};
query.mockRejectedValueOnce = (value) => {
  responseQueue.push({ type: 'reject', value });
  return query;
};
query.mockImplementationOnce = (impl) => {
  responseQueue.push({ type: 'impl', value: impl });
  return query;
};

// Dedicated override queue for tests that need to control a
// "FROM school_years" response precisely (e.g. resolveSchoolYear
// middleware unit tests). Explicit opt-in only — everyone else gets the
// silent default above.
query.mockSchoolYearsResponseOnce = (value) => {
  schoolYearsQueue.push({ type: 'resolve', value });
  return query;
};
query.mockSchoolYearsRejectionOnce = (value) => {
  schoolYearsQueue.push({ type: 'reject', value });
  return query;
};

const db = {
  query,
  connect: jest.fn().mockResolvedValue(mockClient),
  _mockClient: mockClient,
  DEFAULT_SCHOOL_YEAR_ID,
  _reset() {
    responseQueue = [];
    schoolYearsQueue = [];
    this.query.mockReset();
    this.query.mockImplementation(baseImplementation);
    this.connect.mockReset().mockResolvedValue(mockClient);
    mockClient.query.mockReset();
    mockClient.release.mockReset();
  },
};

module.exports = db;
