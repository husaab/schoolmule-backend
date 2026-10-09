const { EventEmitter } = require('events');
const db = require('../../__mocks__/config/database');

jest.mock('../../../services/observe/eventBuffer', () => ({ push: jest.fn(() => true) }));
const buffer = require('../../../services/observe/eventBuffer');
const requestContext = require('../../../services/observe/requestContext');
const observeRequest = require('../../../middleware/observeRequest');

const USER = '550e8400-e29b-41d4-a716-446655440000';

function makeReq(over = {}) {
  return {
    id: 'req-1', method: 'GET', originalUrl: '/api/classes/' + USER + '?x=1', baseUrl: '/api/classes',
    route: { path: '/:id' }, ip: '1.2.3.4', headers: { 'user-agent': 'jest' },
    user: { userId: USER, school: 'ALHAADIACADEMY', role: 'TEACHER' },
    ...over,
  };
}
function makeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.locals = {};
  res.getHeader = () => undefined;
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
}

beforeEach(() => {
  observeRequest._resetLastSeen();
  buffer.push.mockClear();
});

describe('observeRequest', () => {
  it('records a request_events row on finish with the route template', () => {
    const req = makeReq(); const res = makeRes();
    observeRequest(req, res, () => {});
    res.statusCode = 200;
    res.emit('finish');
    expect(buffer.push).toHaveBeenCalledWith('request_events', expect.objectContaining({
      request_id: 'req-1', user_id: USER, school: 'ALHAADIACADEMY', role: 'TEACHER', method: 'GET',
      route: '/api/classes/:id', path: '/api/classes/' + USER, status: 200, ip: '1.2.3.4', user_agent: 'jest', error_message: null,
    }));
    expect(typeof buffer.push.mock.calls[0][1].duration_ms).toBe('number');
  });

  it('captures the response message for 4xx/5xx and not for 2xx', () => {
    const req = makeReq(); const res = makeRes();
    observeRequest(req, res, () => {});
    res.statusCode = 500;
    res.json({ status: 'failed', message: 'Error fetching classes' });
    res.emit('finish');
    expect(buffer.push.mock.calls[0][1].error_message).toBe('Error fetching classes');

    const req2 = makeReq(); const res2 = makeRes();
    observeRequest(req2, res2, () => {});
    res2.json({ status: 'success', message: 'ok' });
    res2.emit('finish');
    expect(buffer.push.mock.calls[1][1].error_message).toBeNull();
  });

  it('survives a 404 with no matched route and a body sent without json()', () => {
    const req = makeReq({ route: undefined, baseUrl: '', originalUrl: '/api/nope/7' }); const res = makeRes();
    observeRequest(req, res, () => {});
    res.statusCode = 404;
    res.emit('finish');
    expect(buffer.push.mock.calls[0][1]).toEqual(expect.objectContaining({ route: '/api/nope/:id', status: 404, error_message: null }));
  });

  it('records only once even if finish fires twice', () => {
    const req = makeReq(); const res = makeRes();
    observeRequest(req, res, () => {});
    res.emit('finish'); res.emit('finish');
    expect(buffer.push).toHaveBeenCalledTimes(1);
  });

  it('records impersonator_id from the token', () => {
    const req = makeReq({ user: { userId: USER, school: 'ALHAADIACADEMY', role: 'PARENT', impersonator: { userId: 'admin-1' } } });
    const res = makeRes();
    observeRequest(req, res, () => {});
    res.emit('finish');
    expect(buffer.push.mock.calls[0][1].impersonator_id).toBe('admin-1');
  });

  it('touches users.last_seen_at at most once per LAST_SEEN_MS per user', () => {
    const res = makeRes();
    observeRequest(makeReq(), res, () => {});
    observeRequest(makeReq(), makeRes(), () => {});
    const updates = db.query.mock.calls.filter(([sql]) => sql.includes('last_seen_at'));
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual([USER]);
  });

  it('does not touch last_seen for an impersonation token', () => {
    observeRequest(makeReq({ user: { userId: USER, impersonator: { userId: 'a' } } }), makeRes(), () => {});
    expect(db.query.mock.calls.filter(([sql]) => sql.includes('last_seen_at'))).toHaveLength(0);
  });

  it('runs next() inside a request context', () => {
    let seen = null;
    observeRequest(makeReq(), makeRes(), () => { seen = requestContext.get(); });
    expect(seen).toEqual(expect.objectContaining({ requestId: 'req-1', userId: USER }));
  });

  it('never throws even if the buffer does', () => {
    buffer.push.mockImplementationOnce(() => { throw new Error('boom'); });
    const res = makeRes();
    observeRequest(makeReq(), res, () => {});
    expect(() => res.emit('finish')).not.toThrow();
  });
});
