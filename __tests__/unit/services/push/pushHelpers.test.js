// The push queue's pure helpers and the category list.
const { isAppPath, preview } = require('../../../../services/push/pushQueue');
const { categoriesFor, isCategory } = require('../../../../services/push/categories');

describe('isAppPath', () => {
  it.each(['/parent/messages?thread=abc', '/student/items/1', '/messages?view=needsReply'])('takes %s', (p) => {
    expect(isAppPath(p)).toBe(true);
  });
  it.each([
    'https://evil.example', '//evil.example/x', 'parent/messages', '/email-login?next=/x#token=abc',
    '/reset-password?token=abc', '/a b', '/a\\b', null, undefined,
  ])('refuses %s', (p) => {
    expect(isAppPath(p)).toBe(false);
  });
});

describe('preview', () => {
  it('flattens rich text to one line', () => {
    expect(preview('<p>Bring a <b>lunch</b>.</p><p>And a hat &amp; water.</p>')).toBe('Bring a lunch. And a hat & water.');
  });
  it('cuts long text with an ellipsis', () => {
    const out = preview('word '.repeat(60), 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
  });
  it('is empty for nothing', () => {
    expect(preview(null)).toBe('');
  });
});

describe('categoriesFor', () => {
  const keys = (roles) => categoriesFor(roles).map((c) => c.key);
  it('gives each role its own', () => {
    expect(keys(['PARENT'])).toEqual(['messages', 'announcements', 'grades', 'reminders']);
    expect(keys(['STUDENT'])).toEqual(['messages', 'announcements', 'grades', 'classwork']);
    expect(keys(['TEACHER'])).toEqual(['messages', 'reminders']);
    expect(keys(['ADMIN'])).toEqual(['messages', 'reminders']);
  });
  it('joins every view a dual-role account holds', () => {
    expect(keys(['TEACHER', 'PARENT'])).toEqual(['messages', 'announcements', 'grades', 'reminders']);
  });
  it('treats an unknown staff role as staff', () => {
    expect(keys(['OFFICE'])).toEqual(['messages', 'reminders']);
  });
  it('knows its keys', () => {
    expect(isCategory('grades')).toBe(true);
    expect(isCategory('marketing')).toBe(false);
  });
});
