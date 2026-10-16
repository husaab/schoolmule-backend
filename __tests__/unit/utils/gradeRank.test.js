const { GRADE_CODES, gradeRank, GRADE_RANK } = require('../../../utils/gradeRank');

describe('gradeRank', () => {
  it('ranks kindergarten below Grade 1', () => {
    expect(gradeRank('JK')).toBe(-1);
    expect(gradeRank('SK')).toBe(0);
  });

  it('ranks Grades 1-8 by number', () => {
    expect(gradeRank('1')).toBe(1);
    expect(gradeRank('5')).toBe(5);
    expect(gradeRank('8')).toBe(8);
  });

  it('returns null for anything that is not a grade code', () => {
    expect(gradeRank('X')).toBeNull();
    expect(gradeRank('9')).toBeNull();
    expect(gradeRank('')).toBeNull();
    expect(gradeRank(null)).toBeNull();
    expect(gradeRank(undefined)).toBeNull();
  });

  it('lists the grade codes in rank order', () => {
    expect(GRADE_CODES).toEqual(['JK', 'SK', '1', '2', '3', '4', '5', '6', '7', '8']);
    const ranks = GRADE_CODES.map(gradeRank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});

describe('GRADE_RANK (SQL twin)', () => {
  it('maps JK and SK in a CASE over the given text expression', () => {
    const sql = GRADE_RANK('s.grade::text');
    expect(sql).toContain("WHEN 'JK' THEN -1");
    expect(sql).toContain("WHEN 'SK' THEN 0");
    expect(sql).toContain('CASE (s.grade::text)');
    expect(sql).toContain("NULLIF(s.grade::text, '')::int");
  });
});
