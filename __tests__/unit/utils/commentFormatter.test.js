const { formatCommentHTML } = require('../../../utils/commentFormatter');

describe('commentFormatter', () => {
  describe('formatCommentHTML', () => {
    it('returns empty string for null input', () => {
      expect(formatCommentHTML(null)).toBe('');
    });

    it('returns empty string for undefined input', () => {
      expect(formatCommentHTML(undefined)).toBe('');
    });

    it('returns empty string for empty string input', () => {
      expect(formatCommentHTML('')).toBe('');
    });

    it('converts **text** to <strong> tags', () => {
      const result = formatCommentHTML('**Bold Text**');
      expect(result).toBe('<strong>Bold Text</strong>');
    });

    it('converts multiple bold markers', () => {
      const result = formatCommentHTML('**First** and **Second**');
      expect(result).toBe('<strong>First</strong> and <strong>Second</strong>');
    });

    it('preserves double newlines as paragraph breaks', () => {
      const result = formatCommentHTML('Paragraph one.\n\nParagraph two.');
      expect(result).toContain('<br/><br/>');
    });

    it('preserves newlines before **headers**', () => {
      const input = '**Reading Skills**\nGood reader.\n**Spelling**\nGood speller.';
      const result = formatCommentHTML(input);
      expect(result).toContain('<strong>Reading Skills</strong>');
      expect(result).toContain('<strong>Spelling</strong>');
    });

    it('escapes HTML entities to prevent XSS', () => {
      const result = formatCommentHTML('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('escapes ampersands', () => {
      const result = formatCommentHTML('A & B');
      expect(result).toBe('A &amp; B');
    });

    it('escapes double quotes', () => {
      const result = formatCommentHTML('He said "hello"');
      expect(result).toContain('&quot;');
    });

    it('converts single newlines mid-paragraph to spaces', () => {
      const result = formatCommentHTML('This is a long\nsentence that wraps.');
      expect(result).toBe('This is a long sentence that wraps.');
    });

    it('handles complex mixed content', () => {
      const input = '**Reading Skills**\nAbbas is a smart student.\n\n**Spelling**\nHe spells well.';
      const result = formatCommentHTML(input);
      expect(result).toContain('<strong>Reading Skills</strong>');
      expect(result).toContain('<strong>Spelling</strong>');
      expect(result).toContain('<br/><br/>');
    });

    it('normalizes \\r\\n line endings', () => {
      const result = formatCommentHTML('Line one.\r\n\r\nLine two.');
      expect(result).toContain('<br/><br/>');
    });
  });
});
