const { parentAskLink, askLabel, askFields, speakLabel } = require('../../../utils/parentLinks');

describe('parentAskLink', () => {
  const env = process.env.FRONTEND_URL;
  beforeEach(() => { process.env.FRONTEND_URL = 'https://schoolmule.test'; });
  afterAll(() => { process.env.FRONTEND_URL = env; });

  const params = (url) => Object.fromEntries(new URL(url).searchParams);

  it('opens Parent Messages on Conversations with the child, class and assessment', () => {
    const url = parentAskLink({ studentId: 's1', classId: 'c1', assessmentId: 'a1' });
    expect(url.startsWith('https://schoolmule.test/parent/messages?')).toBe(true);
    expect(params(url)).toEqual({ tab: 'conversations', ask: 's1', askClass: 'c1', askAssessment: 'a1' });
  });

  it('carries a one-line title for the General fallback, and leaves out what it is not given', () => {
    const url = parentAskLink({ studentId: 's1', classId: 'c1', about: '  Fractions\n worksheet & more ' });
    expect(params(url)).toEqual({ tab: 'conversations', ask: 's1', askClass: 'c1', askAbout: 'Fractions worksheet & more' });
    expect(params(parentAskLink({ studentId: 's1', classId: 'c1', about: 'x'.repeat(300) })).askAbout).toHaveLength(100);
  });
});

describe('askFields', () => {
  it("gives an email row its link and the teacher's name", () => {
    const fields = askFields({ studentId: 's1', classId: 'c1', assessmentId: 'a1', about: 'Quiz 1', teacherName: 'Ms. Clarke' });
    expect(fields).toEqual({ askUrl: parentAskLink({ studentId: 's1', classId: 'c1', assessmentId: 'a1', about: 'Quiz 1' }), askLabel: 'Ask Ms. Clarke about this' });
  });
});

describe('speakLabel', () => {
  it('names the teacher, and says "these grades" for several', () => {
    expect(speakLabel('Ms. Sara')).toBe('Speak to Ms. Sara about this');
    expect(speakLabel('Ms. Sara', 3)).toBe('Speak to Ms. Sara about these grades');
    expect(speakLabel(null)).toBe('Speak to the teacher about this');
  });
});

describe('askLabel', () => {
  it('names the teacher, or falls back when there is no name', () => {
    expect(askLabel('Ms. Clarke')).toBe('Ask Ms. Clarke about this');
    expect(askLabel('  ')).toBe('Ask the teacher about this');
    expect(askLabel(null)).toBe('Ask the teacher about this');
  });
});
