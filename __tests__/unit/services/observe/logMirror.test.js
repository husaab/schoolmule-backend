jest.mock('../../../../services/observe/eventBuffer', () => ({ push: jest.fn(() => true) }));
const buffer = require('../../../../services/observe/eventBuffer');
const requestContext = require('../../../../services/observe/requestContext');
const { onLogLine, shouldSkip } = require('../../../../services/observe/logMirror');

const line = (obj) => JSON.stringify({ level: 'error', time: 1, pid: 1, hostname: 'h', ...obj });

beforeEach(() => buffer.push.mockClear());

describe('logMirror', () => {
  it('pushes an error_events row with message + err and a fingerprint', () => {
    expect(onLogLine(line({ msg: 'Error fetching classes', err: { type: 'Error', message: 'relation "x" does not exist', stack: 'Error: boom\n  at a' } }))).toBe(true);
    const [table, row] = buffer.push.mock.calls[0];
    expect(table).toBe('error_events');
    expect(row).toEqual(expect.objectContaining({ source: 'server', message: 'Error fetching classes: relation "x" does not exist', stack: 'Error: boom\n  at a' }));
    expect(row.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('uses the request context when present', () => {
    const req = { baseUrl: '/api/classes', route: { path: '/:id' }, originalUrl: '/api/classes/1' };
    requestContext.run({ requestId: 'r1', userId: 'u1', school: 'S', req }, () => {
      onLogLine(line({ msg: 'x' }));
    });
    expect(buffer.push.mock.calls[0][1]).toEqual(expect.objectContaining({ request_id: 'r1', user_id: 'u1', school: 'S', route: '/api/classes/:id' }));
  });

  it('skips pino-http auto errors, observe-tagged lines, non-error levels and garbage', () => {
    expect(shouldSkip({ level: 'error', err: { message: 'failed with status code 500' } })).toBe(true);
    expect(shouldSkip({ level: 'error', observe: true, msg: 'observe: flush failed' })).toBe(true);
    expect(shouldSkip({ level: 'warn', msg: 'x' })).toBe(true);
    expect(onLogLine('not json')).toBe(false);
    expect(onLogLine(line({ level: 'info', msg: 'hello' }))).toBe(false);
    expect(buffer.push).not.toHaveBeenCalled();
  });

  it('accepts numeric levels (50 and above)', () => {
    expect(onLogLine(line({ level: 50, msg: 'num' }))).toBe(true);
    expect(onLogLine(line({ level: 60, msg: 'fatal' }))).toBe(true);
    expect(onLogLine(line({ level: 40, msg: 'warn' }))).toBe(false);
  });

  it('truncates stacks to 2000 chars and never throws', () => {
    onLogLine(line({ msg: 'x', err: { message: 'm', stack: 'y'.repeat(5000) } }));
    expect(buffer.push.mock.calls[0][1].stack).toHaveLength(2000);
    buffer.push.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => onLogLine(line({ msg: 'z' }))).not.toThrow();
  });
});
