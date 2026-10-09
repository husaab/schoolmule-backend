const { normalizeLogArgs } = require('../../../utils/logArgs');

describe('normalizeLogArgs', () => {
  const boom = new Error('boom');

  it('lifts an Error passed after a message into the err field', () => {
    expect(normalizeLogArgs(['Error listing announcements:', boom])).toEqual([{ err: boom }, 'Error listing announcements:']);
  });
  it('keeps extra format args after the message', () => {
    expect(normalizeLogArgs(['failed for %s', boom, 'x'])).toEqual([{ err: boom }, 'failed for %s', 'x']);
  });
  it('merges into an existing object first arg when the Error comes later', () => {
    expect(normalizeLogArgs([{ userId: 'u' }, 'msg', boom])).toEqual([{ userId: 'u', err: boom }, 'msg']);
  });
  it('leaves the pino-native shapes alone', () => {
    expect(normalizeLogArgs([boom])).toEqual([boom]);
    expect(normalizeLogArgs([{ err: boom }, 'msg'])).toEqual([{ err: boom }, 'msg']);
    expect(normalizeLogArgs(['plain message'])).toEqual(['plain message']);
    expect(normalizeLogArgs(['msg', 'not an error'])).toEqual(['msg', 'not an error']);
  });
  it('does not override an err already present', () => {
    const other = new Error('other');
    expect(normalizeLogArgs([{ err: other }, 'msg', boom])).toEqual([{ err: other }, 'msg']);
  });
});

describe('normalizeLogArgs with non-Error failure objects', () => {
  it('wraps a thrown { status, message } object into an Error with the original as cause', () => {
    const thrown = { status: 404, message: 'User not found' };
    const [first, msg] = normalizeLogArgs(['Login failed:', thrown]);
    expect(msg).toBe('Login failed:');
    expect(first.err).toBeInstanceOf(Error);
    expect(first.err.message).toBe('User not found');
    expect(first.err.cause).toBe(thrown);
  });
  it('wraps a Supabase-style { error: { message } } result', () => {
    const result = { error: { message: 'Bucket not found', statusCode: '404' }, data: null };
    const [first] = normalizeLogArgs(['Upload failed:', result]);
    expect(first.err).toBeInstanceOf(Error);
    expect(first.err.message).toBe('Bucket not found');
    expect(first.err.cause).toBe(result.error);
  });
  it('leaves ordinary objects without a message alone', () => {
    expect(normalizeLogArgs(['stats', { count: 3 }])).toEqual(['stats', { count: 3 }]);
    expect(normalizeLogArgs(['msg', null])).toEqual(['msg', null]);
  });
});
