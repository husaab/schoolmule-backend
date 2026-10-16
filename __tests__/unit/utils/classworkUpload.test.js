// classworkUpload: link helpers (YouTube ids, http/https only) and the file path.
const { youtubeIdOf, parseLinkUrl, parseLinkTitle, classworkFilePath } = require('../../../utils/classworkUpload');

describe('youtubeIdOf', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=42', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('%s → %s', (url, id) => expect(youtubeIdOf(url)).toBe(id));

  it.each([
    'https://www.youtube.com/channel/UC123',
    'https://www.youtube.com/watch?v=short',
    'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://example.com/youtu.be/dQw4w9WgXcQ',
    'not a url',
  ])('%s has no video id', (url) => expect(youtubeIdOf(url)).toBeNull());
});

describe('parseLinkUrl', () => {
  it('keeps an http or https link, trimmed', () => {
    expect(parseLinkUrl('  https://example.com/cells  ')).toBe('https://example.com/cells');
    expect(parseLinkUrl('http://example.com')).toBe('http://example.com');
  });
  it.each(['ftp://example.com/file', 'javascript:alert(1)', 'example.com', '', null, 42])('refuses %p', (value) => {
    expect(parseLinkUrl(value)).toBeNull();
  });
  it('refuses a link over 2000 characters', () => expect(parseLinkUrl(`https://example.com/${'x'.repeat(2000)}`)).toBeNull());
});

describe('parseLinkTitle', () => {
  it('trims, and an empty title is null', () => {
    expect(parseLinkTitle('  Cells video ')).toEqual({ value: 'Cells video' });
    expect(parseLinkTitle('   ')).toEqual({ value: null });
    expect(parseLinkTitle(undefined)).toEqual({ value: null });
  });
  it('refuses a long or non-text title', () => {
    expect(parseLinkTitle('x'.repeat(201)).error).toMatch(/200/);
    expect(parseLinkTitle(5).error).toMatch(/text/);
  });
});

describe('classworkFilePath', () => {
  it('puts the file under the school and item, with a fresh name and the lower-cased extension', () => {
    expect(classworkFilePath('ALHAADIACADEMY', 'item-1', 'Checklist.PDF'))
      .toMatch(/^ALHAADIACADEMY\/classwork\/item-1\/[0-9a-f-]{36}\.pdf$/);
  });
});
