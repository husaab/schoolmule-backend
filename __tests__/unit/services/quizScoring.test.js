// Quiz scoring (T23): the machine's points per answer, the attempt's totals
// (a teacher override wins over the machine), the release rule and the
// builder's validation. Pure functions; no database.

const {
  normalizeShort, autoPoints, effectivePoints, attemptTotals, canReleaseOnSubmit, validateQuestions,
} = require('../../../services/classroom/quizScoring');

const one = { question_id: 'q1', kind: 'one', points: 2, correct: ['b'], options: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
const many = (extra = {}) => ({ question_id: 'q2', kind: 'many', points: 2, correct: ['a', 'b'], partial_credit: false, ...extra });
const short = { question_id: 'q3', kind: 'short', points: 1, accepted: ['cytoplasm'] };
const long = { question_id: 'q4', kind: 'long', points: 3 };

describe('autoPoints', () => {
  it('one answer: right, wrong, blank', () => {
    expect(autoPoints(one, { choice: 'b' })).toBe(2);
    expect(autoPoints(one, { choice: 'a' })).toBe(0);
    expect(autoPoints(one, null)).toBe(0);
    expect(autoPoints(one, {})).toBe(0);
  });

  it('several answers, all or nothing: the exact set scores; a superset or a subset does not', () => {
    expect(autoPoints(many(), { choices: ['b', 'a'] })).toBe(2);
    expect(autoPoints(many(), { choices: ['a', 'b', 'c'] })).toBe(0);
    expect(autoPoints(many(), { choices: ['a'] })).toBe(0);
    expect(autoPoints(many(), { choices: [] })).toBe(0);
    expect(autoPoints(many(), null)).toBe(0);
  });

  it('several answers with partial credit: (right - wrong) / right answers x points, never below 0', () => {
    // 2 of 2 right + 1 wrong (of 4 options): (2 - 1) / 2 x 2
    expect(autoPoints(many({ partial_credit: true }), { choices: ['a', 'b', 'c'] })).toBe(1);
    expect(autoPoints(many({ partial_credit: true }), { choices: ['a', 'b'] })).toBe(2);
    expect(autoPoints(many({ partial_credit: true }), { choices: ['a'] })).toBe(1);
    expect(autoPoints(many({ partial_credit: true }), { choices: ['c', 'd'] })).toBe(0);
    expect(autoPoints(many({ partial_credit: true, points: 1, correct: ['a', 'b', 'c'] }), { choices: ['a'] })).toBe(0.33);
  });

  it('short text: case and extra spaces do not matter, punctuation does', () => {
    expect(autoPoints(short, { text: '  Cytoplasm ' })).toBe(1);
    expect(autoPoints(short, { text: 'CYTO PLASM' })).toBe(0);
    expect(autoPoints(short, { text: 'cytoplasm.' })).toBe(0);
    expect(autoPoints(short, { text: '   ' })).toBe(0);
    expect(autoPoints({ ...short, accepted: ['red  blood cell'] }, { text: 'Red blood   cell' })).toBe(1);
    expect(normalizeShort('  Ｃｙｔｏ  plasm ')).toBe('cyto plasm');
  });

  it('a written answer is for the teacher (null)', () => {
    expect(autoPoints(long, { text: 'Plant cells need a wall to stay rigid.' })).toBeNull();
    expect(autoPoints(long, null)).toBeNull();
  });

  it('is deterministic: the same answer always scores the same', () => {
    const answer = { choices: ['a', 'b', 'c'] };
    const q = many({ partial_credit: true });
    expect(new Set(Array.from({ length: 5 }, () => autoPoints(q, answer)))).toEqual(new Set([1]));
  });
});

describe('effectivePoints', () => {
  it('prefers a 0 override over auto points of 2', () => {
    expect(effectivePoints({ auto_points: '2.00', teacher_points: '0.00' })).toBe(0);
    expect(effectivePoints({ auto_points: '2.00', teacher_points: null })).toBe(2);
    expect(effectivePoints({ auto_points: null, teacher_points: null })).toBeNull();
  });
});

describe('attemptTotals', () => {
  it('needs review while a written answer has no points; earned counts the rest', () => {
    const answers = [
      { question_id: 'q1', auto_points: '2.00', teacher_points: null },
      { question_id: 'q2', auto_points: '0.00', teacher_points: null },
      { question_id: 'q3', auto_points: '1.00', teacher_points: null },
      { question_id: 'q4', auto_points: null, teacher_points: null },
    ];
    expect(attemptTotals([one, many(), short, long], answers)).toEqual({ earned: 3, possible: 8, needsReview: true });
    answers[3].teacher_points = '2.5';
    expect(attemptTotals([one, many(), short, long], answers)).toEqual({ earned: 5.5, possible: 8, needsReview: false });
  });

  it('an unanswered auto-graded question is 0; an unanswered written one needs review', () => {
    expect(attemptTotals([one, short], [])).toEqual({ earned: 0, possible: 3, needsReview: false });
    expect(attemptTotals([one, long], [])).toEqual({ earned: 0, possible: 5, needsReview: true });
  });
});

describe('canReleaseOnSubmit', () => {
  it('only when every question is auto-graded', () => {
    expect(canReleaseOnSubmit([one, many(), short])).toBe(true);
    expect(canReleaseOnSubmit([one, long])).toBe(false);
    expect(canReleaseOnSubmit([])).toBe(true);
  });
});

describe('validateQuestions', () => {
  const opts = (n) => ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].slice(0, n).map((id) => ({ id, text: `Choice ${id}` }));
  const oneQ = (extra = {}) => ({ kind: 'one', prompt: 'Which part makes food?', options: opts(4), correct: ['b'], points: 2, ...extra });
  const ok = (list, o) => {
    const r = validateQuestions(list, o);
    if (r.error) throw new Error(r.error);
    return r.value;
  };
  const err = (list, o) => validateQuestions(list, o).error;

  it('normalizes a valid list of every kind', () => {
    const value = ok([
      oneQ({ prompt: '  Which part makes food?  ', options: [{ id: 'a', text: ' Nucleus ' }, { id: 'b', text: 'Chloroplast' }] }),
      { kind: 'many', prompt: 'Plant only?', options: opts(4), correct: ['b', 'a'], points: 2, partialCredit: true },
      { kind: 'short', prompt: 'Jelly inside?', accepted: [' cytoplasm '], points: 1, options: [{ id: 'a', text: 'ignored' }] },
      { kind: 'long', prompt: 'Why a wall?', points: 3, questionId: 'A0000000-0000-4000-8000-000000000001', imagePath: null },
    ]);
    expect(value[0]).toEqual({
      questionId: null, kind: 'one', prompt: 'Which part makes food?', imagePath: null,
      options: [{ id: 'a', text: 'Nucleus' }, { id: 'b', text: 'Chloroplast' }], correct: ['b'], accepted: [], points: 2, partialCredit: false,
    });
    expect(value[1]).toMatchObject({ kind: 'many', correct: ['a', 'b'], partialCredit: true });
    expect(value[2]).toMatchObject({ kind: 'short', options: [], correct: [], accepted: ['cytoplasm'] });
    expect(value[3]).toMatchObject({ kind: 'long', questionId: 'a0000000-0000-4000-8000-000000000001', options: [], accepted: [] });
  });

  it('1 to 50 questions', () => {
    expect(err([])).toBe('Add at least one question');
    expect(err('nope')).toBe('Add at least one question');
    expect(ok(Array.from({ length: 50 }, () => oneQ()))).toHaveLength(50);
    expect(err(Array.from({ length: 51 }, () => oneQ()))).toBe('A quiz holds at most 50 questions');
  });

  it('a prompt of 1 to 1 000 characters and a known kind', () => {
    expect(err([oneQ({ prompt: '   ' })])).toBe('Question 1: write the question');
    expect(ok([oneQ({ prompt: 'x'.repeat(1000) })])).toHaveLength(1);
    expect(err([oneQ({ prompt: 'x'.repeat(1001) })])).toBe('Question 1: keep the question to 1,000 characters');
    expect(err([oneQ({ kind: 'essay' })])).toMatch(/^Question 1: choose/);
    expect(err([null])).toBe('Question 1 must be an object');
  });

  it('one/many: 2 to 8 choices, unique ids a to h, text 1 to 300', () => {
    expect(err([oneQ({ options: opts(1), correct: ['a'] })])).toBe('Question 1: give it 2 to 8 choices');
    expect(ok([oneQ({ options: opts(8) })])).toHaveLength(1);
    expect(err([oneQ({ options: [...opts(8), { id: 'a', text: 'x' }] })])).toBe('Question 1: give it 2 to 8 choices');
    expect(err([oneQ({ options: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }], correct: ['a'] })])).toBe('Question 1: two choices share the id "a"');
    expect(err([oneQ({ options: [{ id: 'a', text: 'x' }, { id: 'z', text: 'y' }], correct: ['a'] })])).toBe('Question 1: choice ids are the letters a to h');
    expect(err([oneQ({ options: [{ id: 'a', text: 'x' }, { id: 'b', text: ' ' }] })])).toBe('Question 1: every choice needs 1 to 300 characters');
    expect(err([oneQ({ options: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y'.repeat(301) }] })])).toBe('Question 1: every choice needs 1 to 300 characters');
  });

  it('one has exactly one right answer; many at least one; right answers are choices', () => {
    expect(err([oneQ({ correct: [] })])).toBe('Question 1: mark exactly one right answer');
    expect(err([oneQ({ correct: ['a', 'b'] })])).toBe('Question 1: mark exactly one right answer');
    expect(err([oneQ({ correct: ['h'] })])).toBe("Question 1: a right answer isn't one of the choices");
    expect(err([oneQ({ correct: 'b' })])).toBe('Question 1: mark the right answer');
    expect(err([oneQ({ kind: 'many', correct: [] })])).toBe('Question 1: mark at least one right answer');
    expect(err([oneQ({ kind: 'many', correct: ['a', 'a'] })])).toBe('Question 1: a right answer is listed twice');
    expect(ok([oneQ({ kind: 'many', correct: ['a', 'b', 'c'] })])[0].correct).toEqual(['a', 'b', 'c']);
  });

  it('short: 1 to 10 non-empty accepted answers', () => {
    const shortQ = (accepted) => ({ kind: 'short', prompt: 'Jelly inside?', accepted, points: 1 });
    expect(err([shortQ([])])).toBe('Question 1: give 1 to 10 accepted answers');
    expect(err([shortQ(undefined)])).toBe('Question 1: give 1 to 10 accepted answers');
    expect(ok([shortQ(Array.from({ length: 10 }, (_, i) => `a${i}`))])).toHaveLength(1);
    expect(err([shortQ(Array.from({ length: 11 }, (_, i) => `a${i}`))])).toBe('Question 1: give 1 to 10 accepted answers');
    expect(err([shortQ(['cytoplasm', '  '])])).toBe('Question 1: every accepted answer needs 1 to 300 characters');
  });

  it('points from 0 to 100', () => {
    expect(ok([oneQ({ points: 0 })])[0].points).toBe(0);
    expect(ok([oneQ({ points: 100 })])[0].points).toBe(100);
    expect(ok([oneQ({ points: 1.257 })])[0].points).toBe(1.26);
    for (const points of [-1, 100.5, '2', null, undefined, NaN, true]) {
      expect(err([oneQ({ points })])).toBe('Question 1: points must be from 0 to 100');
    }
  });

  it('partial credit only for several answers', () => {
    expect(err([oneQ({ partialCredit: true })])).toBe('Question 1: partial points are only for several-answer questions');
    expect(err([{ kind: 'short', prompt: 'x', accepted: ['y'], points: 1, partialCredit: true }])).toMatch(/partial points/);
    expect(err([oneQ({ partialCredit: 'yes' })])).toBe('Question 1: partialCredit must be true or false');
    expect(ok([oneQ({ partialCredit: false })])[0].partialCredit).toBe(false);
  });

  it('question ids are uuids, listed once', () => {
    const id = 'a0000000-0000-4000-8000-000000000001';
    expect(err([oneQ({ questionId: 'q1' })])).toBe('Question 1 has an unknown id');
    expect(err([oneQ({ questionId: id }), oneQ({ questionId: id.toUpperCase() })])).toBe('Question 2 is listed twice');
  });

  it("an image must be stored in this quiz's folder", () => {
    const imagePrefix = 'ALHAADIACADEMY/classwork/item-1/questions/';
    expect(ok([oneQ({ imagePath: `${imagePrefix}x.png` })], { imagePrefix })[0].imagePath).toBe(`${imagePrefix}x.png`);
    for (const imagePath of ['OTHER/classwork/item-2/questions/x.png', `${imagePrefix}../../x.png`, `/${imagePrefix}x.png`, 42]) {
      expect(err([oneQ({ imagePath })], { imagePrefix })).toBe('Question 1: upload the image again');
    }
  });
});
