const { editWindowMs, canEditMessage, editWindowText } = require('../../../utils/messageEditRules');

const ME = 'user-1';
const minutesAgo = (n, now) => new Date(now - n * 60 * 1000).toISOString();
const NOW = Date.parse('2026-11-09T15:00:00Z');
const message = (over = {}) => ({
  sender_id: ME, sender_role: 'TEACHER', kind: 'message', deleted_at: null, created_at: minutesAgo(1, NOW), ...over,
});

describe('editWindowMs', () => {
  it('gives staff no limit', () => {
    expect(editWindowMs('TEACHER')).toBeNull();
    expect(editWindowMs('ADMIN')).toBeNull();
  });

  it('gives parents 30 minutes and students 15', () => {
    expect(editWindowMs('PARENT')).toBe(30 * 60 * 1000);
    expect(editWindowMs('STUDENT')).toBe(15 * 60 * 1000);
  });
});

describe('canEditMessage', () => {
  it('lets staff edit their own message however old it is', () => {
    expect(canEditMessage(message({ created_at: '2024-01-01T00:00:00Z' }), ME, NOW)).toBe(true);
  });

  it('closes a parent message after 30 minutes', () => {
    expect(canEditMessage(message({ sender_role: 'PARENT', created_at: minutesAgo(29, NOW) }), ME, NOW)).toBe(true);
    expect(canEditMessage(message({ sender_role: 'PARENT', created_at: minutesAgo(31, NOW) }), ME, NOW)).toBe(false);
  });

  it('closes a student message after 15 minutes', () => {
    expect(canEditMessage(message({ sender_role: 'STUDENT', created_at: minutesAgo(14, NOW) }), ME, NOW)).toBe(true);
    expect(canEditMessage(message({ sender_role: 'STUDENT', created_at: minutesAgo(16, NOW) }), ME, NOW)).toBe(false);
  });

  it("never allows someone else's, a removed or a system message", () => {
    expect(canEditMessage(message({ sender_id: 'user-2' }), ME, NOW)).toBe(false);
    expect(canEditMessage(message({ deleted_at: minutesAgo(1, NOW) }), ME, NOW)).toBe(false);
    expect(canEditMessage(message({ kind: 'system' }), ME, NOW)).toBe(false);
  });
});

describe('editWindowText', () => {
  it('names the limit for the role the message was sent as', () => {
    expect(editWindowText('PARENT')).toBe('Messages can be edited for 30 minutes after sending');
    expect(editWindowText('STUDENT')).toBe('Messages can be edited for 15 minutes after sending');
  });
});
