const { countWords, wordCountSql } = require('../../../utils/wordCount');

describe('countWords', () => {
  it('counts runs of anything that is not whitespace', () => {
    expect(countWords('Amal works hard.')).toBe(3);
    expect(countWords('one')).toBe(1);
    expect(countWords("well-behaved, isn't she?")).toBe(3);
  });

  it('is zero for blank text and for anything that is not text', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t ')).toBe(0);
    expect(countWords(null)).toBe(0);
    expect(countWords(undefined)).toBe(0);
    expect(countWords(42)).toBe(0);
  });

  it('treats spaces, tabs, line breaks and no-break spaces as gaps, however many', () => {
    expect(countWords('  one two\tthree\nfour\r\nfive six  ')).toBe(6);
    expect(countWords('one\n\n\ntwo')).toBe(2);
  });

  it('counts a mark standing on its own as a word, as word processors do', () => {
    expect(countWords('reading - and writing')).toBe(4);
  });
});

describe('wordCountSql', () => {
  it('wraps the expression in a count of the same runs', () => {
    const sql = wordCountSql('f.comment');
    expect(sql).toContain("regexp_matches(COALESCE(f.comment, '')");
    expect(sql).toContain('[^ \\t\\n\\r\\f\\v\\u00A0]+');
  });
});
