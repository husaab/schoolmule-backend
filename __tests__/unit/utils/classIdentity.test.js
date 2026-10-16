const {
  FAMILIES, COLORS, FAMILY_DEFAULT_COLOR, subjectFamily, isFamily, isColor, resolveIdentity,
} = require('../../../utils/classIdentity');

const bannerPublicUrl = (path) => `https://cdn.example.com/school-assets/${path}`;

describe('classIdentity: the keys', () => {
  it('lists the 13 families and 11 colors in picker order', () => {
    expect(FAMILIES).toEqual([
      'quran', 'arabic', 'islamic', 'french', 'computer', 'english', 'science',
      'math', 'social', 'pe', 'art', 'kindergarten', 'default',
    ]);
    expect(COLORS).toEqual([
      'teal', 'blue', 'emerald', 'lime', 'yellow', 'orange', 'rose', 'pink', 'purple', 'sky', 'slate',
    ]);
  });

  it('gives every family a default color from the palette', () => {
    expect(Object.keys(FAMILY_DEFAULT_COLOR).sort()).toEqual([...FAMILIES].sort());
    for (const color of Object.values(FAMILY_DEFAULT_COLOR)) expect(COLORS).toContain(color);
    expect(FAMILY_DEFAULT_COLOR).toEqual({
      quran: 'emerald', arabic: 'orange', islamic: 'pink', french: 'yellow', computer: 'slate',
      english: 'rose', science: 'teal', math: 'blue', social: 'sky', pe: 'lime', art: 'purple',
      kindergarten: 'sky', default: 'slate',
    });
  });

  it('checks keys without matching inherited properties', () => {
    expect(isFamily('quran')).toBe(true);
    expect(isFamily('default')).toBe(true);
    expect(isFamily('Quran')).toBe(false);
    expect(isFamily('toString')).toBe(false);
    expect(isFamily(null)).toBe(false);
    expect(isColor('teal')).toBe(true);
    expect(isColor('red')).toBe(false);
    expect(isColor(undefined)).toBe(false);
  });
});

describe('classIdentity: subjectFamily', () => {
  // Every spelling in the Al Haadi prod data, plus the demo classes.
  const cases = [
    ['Quran', 'quran'], ['Quran Teaching', 'quran'], ['Quran Teaching and Memorization', 'quran'],
    ['Arabic', 'arabic'],
    ['Islamic', 'islamic'], ['Islamic Studies', 'islamic'],
    ['French', 'french'], ['Français', 'french'], ['Francais', 'french'],
    ['Computer Science', 'computer'], ['Computer Studies', 'computer'], ['Coding', 'computer'],
    ['ICT', 'computer'], ['Technology', 'computer'],
    ['English', 'english'], ['English Language Arts', 'english'], ['Literacy', 'english'],
    ['Science', 'science'], ['Physics', 'science'], ['Chemistry', 'science'], ['Biology', 'science'],
    ['Math', 'math'], ['Mathematics', 'math'],
    ['Social Studies', 'social'], ['History', 'social'], ['Geography', 'social'],
    ['Physical Education', 'pe'], ['Physical Activities', 'pe'], ['Gym', 'pe'], ['P.E.', 'pe'], ['PE', 'pe'], ['Sports', 'pe'],
    ['Art', 'art'], ['Arts', 'art'], ['Visual Arts', 'art'], ['Drawing', 'art'],
    ['Junior Kindergarten', 'kindergarten'], ['Senior Kindergarten', 'kindergarten'],
    ['Loper', 'default'], ['Test', 'default'],
  ];
  it.each(cases)('maps %s to %s', (subject, family) => {
    expect(subjectFamily(subject, '5')).toBe(family);
  });

  it('matches case-insensitively and ignores padding', () => {
    expect(subjectFamily('  QURAN  ', '3')).toBe('quran');
    expect(subjectFamily('mAtH', 3)).toBe('math');
  });

  it('applies the rules in order, first match wins', () => {
    expect(subjectFamily('Islamic Studies and Quran', '4')).toBe('quran');
    expect(subjectFamily('Arabic and Islamic Studies', '4')).toBe('arabic');
    expect(subjectFamily('French Language Arts', '4')).toBe('french');
    expect(subjectFamily('Computer Science', '4')).toBe('computer');
    // "art" must not match inside other words (the art rule needs a word boundary)
    expect(subjectFamily('Smart Start', '4')).toBe('default');
    expect(subjectFamily('Heart and Soul', '4')).toBe('default');
    expect(subjectFamily('Partners', '4')).toBe('default');
    // "pe" must not match inside other words
    expect(subjectFamily('Pet Care', '4')).toBe('default');
    expect(subjectFamily('Speech', '4')).toBe('default');
  });

  it('sends JK and SK classes with an unknown subject to kindergarten, others to default', () => {
    expect(subjectFamily('Homeroom', 'SK')).toBe('kindergarten');
    expect(subjectFamily('Homeroom', 'JK')).toBe('kindergarten');
    expect(subjectFamily('Homeroom', '1')).toBe('default');
    expect(subjectFamily('Homeroom', null)).toBe('default');
    expect(subjectFamily(null, undefined)).toBe('default');
    expect(subjectFamily('', 'SK')).toBe('kindergarten');
  });

  it('lets a subject keyword win over the kindergarten grade fallback', () => {
    expect(subjectFamily('Quran', 'JK')).toBe('quran');
    expect(subjectFamily('Math', 'SK')).toBe('math');
  });
});

describe('classIdentity: resolveIdentity', () => {
  it('with nothing stored uses the subject family for banner, icon and color', () => {
    const identity = resolveIdentity({ subject: 'Science', grade: '5' }, { bannerPublicUrl });
    expect(identity).toEqual({
      family: 'science',
      bannerKey: 'science',
      bannerIsUpload: false,
      bannerUrl: '/class-banners/science.svg',
      iconKey: 'science',
      iconUrl: '/class-icons/science.svg',
      color: 'teal',
      isDefault: { banner: true, icon: true, color: true },
    });
  });

  it('keeps library picks and marks only the picked parts as not default', () => {
    const identity = resolveIdentity(
      { subject: 'Science', grade: '5', banner_key: 'math', icon_key: 'art', color: 'rose' },
      { bannerPublicUrl },
    );
    expect(identity).toMatchObject({
      family: 'science', bannerKey: 'math', bannerUrl: '/class-banners/math.svg',
      iconKey: 'art', iconUrl: '/class-icons/art.svg', color: 'rose',
      isDefault: { banner: false, icon: false, color: false },
    });
  });

  it('reports an upload: no bannerKey, the URL from the injected function', () => {
    const identity = resolveIdentity(
      { subject: 'Math', grade: '4', banner_path: 'ALHAADIACADEMY/class-banners/c1/b.png' },
      { bannerPublicUrl },
    );
    expect(identity.bannerIsUpload).toBe(true);
    expect(identity.bannerKey).toBeNull();
    expect(identity.bannerUrl).toBe('https://cdn.example.com/school-assets/ALHAADIACADEMY/class-banners/c1/b.png');
    expect(identity.isDefault.banner).toBe(false);
    expect(identity.family).toBe('math');
  });

  it('an upload wins over a stored library key', () => {
    const identity = resolveIdentity(
      { subject: 'Math', grade: '4', banner_key: 'art', banner_path: 'S/class-banners/c1/b.png' },
      { bannerPublicUrl },
    );
    expect(identity.bannerIsUpload).toBe(true);
    expect(identity.bannerKey).toBeNull();
  });

  it('falls back to the family when a stored key is invalid', () => {
    const identity = resolveIdentity(
      { subject: 'Arabic', grade: '2', banner_key: 'mohawk', icon_key: '', color: 'chartreuse' },
      { bannerPublicUrl },
    );
    expect(identity).toMatchObject({
      bannerKey: 'arabic', iconKey: 'arabic', color: 'orange',
      isDefault: { banner: true, icon: true, color: true },
    });
  });

  it('reads the grade as text (the column is an enum in prod)', () => {
    expect(resolveIdentity({ subject: 'Homeroom', grade: 'SK' }, { bannerPublicUrl }).family).toBe('kindergarten');
    expect(resolveIdentity({ subject: 'Homeroom', grade: 3 }, { bannerPublicUrl }).family).toBe('default');
    expect(resolveIdentity({ subject: 'Homeroom' }, { bannerPublicUrl }).family).toBe('default');
  });
});
