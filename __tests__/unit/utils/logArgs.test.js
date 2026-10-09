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
