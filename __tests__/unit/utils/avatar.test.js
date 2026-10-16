const {
  STYLES, SKIN_COUNT, BG_COUNT, validateAvatar, avatarPngUrl, studentAvatarSql,
} = require('../../../utils/avatar');

describe('avatar: validateAvatar', () => {
  it('lists the six styles in picker order', () => {
    expect(STYLES).toEqual(['short', 'long', 'hijab', 'kufi', 'beard', 'curly']);
    expect(SKIN_COUNT).toBe(5);
    expect(BG_COUNT).toBe(8);
  });

  it('accepts a valid spec', () => {
    expect(validateAvatar({ style: 'hijab', skin: 2, bg: 7 })).toEqual({ value: { style: 'hijab', skin: 2, bg: 7 } });
  });

  it('accepts every style and the edge indexes', () => {
    for (const style of STYLES) {
      expect(validateAvatar({ style, skin: 0, bg: 0 }).value).toEqual({ style, skin: 0, bg: 0 });
      expect(validateAvatar({ style, skin: 4, bg: 7 }).value).toEqual({ style, skin: 4, bg: 7 });
    }
  });

  it('treats null and undefined as "no avatar" (the neutral one)', () => {
    expect(validateAvatar(null)).toEqual({ value: null });
    expect(validateAvatar(undefined)).toEqual({ value: null });
  });

  it('drops extra keys', () => {
    expect(validateAvatar({ style: 'short', skin: 1, bg: 3, hair: 'red', url: 'http://x' }))
      .toEqual({ value: { style: 'short', skin: 1, bg: 3 } });
  });

  const ERROR = { error: 'Pick a style, skin tone and background' };
  it.each([
    ['an unknown style', { style: 'mohawk', skin: 0, bg: 0 }],
    ['a skin of 5', { style: 'short', skin: 5, bg: 0 }],
    ['a negative skin', { style: 'short', skin: -1, bg: 0 }],
    ['a background of 8', { style: 'short', skin: 0, bg: 8 }],
    ['a fractional skin', { style: 'short', skin: 1.5, bg: 0 }],
    ['a string skin', { style: 'short', skin: '1', bg: 0 }],
    ['a missing background', { style: 'short', skin: 1 }],
    ['a missing style', { skin: 1, bg: 1 }],
    ['an inherited style name', { style: 'constructor', skin: 1, bg: 1 }],
    ['a string', 'short'],
    ['an array', [{ style: 'short', skin: 0, bg: 0 }]],
    ['a number', 7],
    ['NaN indexes', { style: 'short', skin: NaN, bg: NaN }],
  ])('rejects %s', (_label, input) => {
    expect(validateAvatar(input)).toEqual(ERROR);
  });
});

describe('avatar: avatarPngUrl', () => {
  const ORIGINAL = process.env.EMAIL_ASSET_BASE_URL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.EMAIL_ASSET_BASE_URL;
    else process.env.EMAIL_ASSET_BASE_URL = ORIGINAL;
  });

  it('points a null avatar at the neutral PNG', () => {
    delete process.env.EMAIL_ASSET_BASE_URL;
    expect(avatarPngUrl(null)).toBe('https://schoolmule.ca/email/avatars/neutral.png');
    expect(avatarPngUrl(undefined).endsWith('/email/avatars/neutral.png')).toBe(true);
  });

  it('names a chosen avatar <style>-<skin>-<bg>.png', () => {
    delete process.env.EMAIL_ASSET_BASE_URL;
    expect(avatarPngUrl({ style: 'kufi', skin: 3, bg: 5 })).toBe('https://schoolmule.ca/email/avatars/kufi-3-5.png');
  });

  it('uses EMAIL_ASSET_BASE_URL when set', () => {
    process.env.EMAIL_ASSET_BASE_URL = 'https://assets.example.com';
    expect(avatarPngUrl({ style: 'curly', skin: 0, bg: 1 })).toBe('https://assets.example.com/email/avatars/curly-0-1.png');
  });

  it('falls back to the neutral PNG for a stored spec that is no longer valid', () => {
    delete process.env.EMAIL_ASSET_BASE_URL;
    expect(avatarPngUrl({ style: 'mohawk', skin: 0, bg: 0 }).endsWith('/email/avatars/neutral.png')).toBe(true);
  });
});

describe('avatar: studentAvatarSql', () => {
  it('prefers the linked student login over the teacher-set avatar', () => {
    const sql = studentAvatarSql('students');
    expect(sql).toContain('COALESCE(');
    expect(sql).toContain('student_account_links');
    expect(sql).toContain('su.avatar');
    expect(sql).toContain('students.avatar');
    expect(sql).toContain('students.student_id');
    expect(sql.trim().endsWith('AS avatar')).toBe(true);
  });

  it('can name the result column', () => {
    expect(studentAvatarSql('s', 'student_avatar').trim().endsWith('AS student_avatar')).toBe(true);
  });

  it('can be aliased', () => {
    const sql = studentAvatarSql('s');
    expect(sql).toContain('s.student_id');
    expect(sql).toContain('s.avatar');
    expect(sql).not.toContain('students.');
  });
});
