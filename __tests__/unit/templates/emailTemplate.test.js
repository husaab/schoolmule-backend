const {
  getReportCardEmailHTML,
  getProgressReportEmailHTML,
  getDefaultEmailBody,
  resolveEmailBody,
} = require('../../../templates/emailTemplate');

describe('emailTemplate – editable body & merge tags', () => {
  // ─── resolveEmailBody ──────────────────────────────────────────
  describe('resolveEmailBody', () => {
    it('substitutes [Student Name] and [Term] with the passed values', () => {
      const html = resolveEmailBody({
        customMessage: 'Hi, this is [Student Name]\'s report for [Term].',
        reportType: 'report_card',
        studentName: 'Aisha Khan',
        term: 'Final Term',
      });

      expect(html).toContain('Aisha Khan');
      expect(html).toContain('Final Term');
      expect(html).not.toContain('[Student Name]');
      expect(html).not.toContain('[Term]');
    });

    it('substitutes every occurrence of a tag', () => {
      const html = resolveEmailBody({
        customMessage: '[Student Name] [Student Name] [Term] [Term]',
        reportType: 'report_card',
        studentName: 'Bob',
        term: 'T2',
      });

      expect(html).toBe('Bob Bob T2 T2');
    });

    it('falls back to the default body when the message is empty', () => {
      const html = resolveEmailBody({
        customMessage: '',
        reportType: 'report_card',
        studentName: 'Aisha Khan',
        term: 'Term 2',
      });

      expect(html).toContain('Please find attached the report card for Aisha Khan for Term 2.');
    });

    it('falls back to the default body when the message is only whitespace', () => {
      const html = resolveEmailBody({
        customMessage: '   \n  ',
        reportType: 'progress_report',
        studentName: 'Sam',
        term: 'Term 1',
      });

      expect(html).toContain('Please find attached the progress report for Sam for Term 1.');
    });

    it('uses the progress_report default for progress reports', () => {
      const html = resolveEmailBody({
        customMessage: undefined,
        reportType: 'progress_report',
        studentName: 'Sam',
        term: 'Term 1',
      });

      expect(html).toContain('progress report');
      expect(html).not.toContain('report card');
    });

    it('HTML-escapes the teacher text before converting newlines', () => {
      const html = resolveEmailBody({
        customMessage: 'Look <script>alert(1)</script> & "quotes" \'apos\'',
        reportType: 'report_card',
        studentName: 'Aisha',
        term: 'Term 2',
      });

      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).toContain('&amp;');
      expect(html).toContain('&quot;quotes&quot;');
      expect(html).toContain('&#039;apos&#039;');
      expect(html).not.toContain('<script>');
    });

    it('escapes HTML in the substituted student name', () => {
      const html = resolveEmailBody({
        customMessage: 'For [Student Name].',
        reportType: 'report_card',
        studentName: '<b>Eve</b>',
        term: 'Term 2',
      });

      expect(html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
      expect(html).not.toContain('<b>Eve</b>');
    });

    it('passes unknown tags through unchanged', () => {
      const html = resolveEmailBody({
        customMessage: 'Hello [Foo] and [Student Name].',
        reportType: 'report_card',
        studentName: 'Aisha',
        term: 'Term 2',
      });

      expect(html).toContain('[Foo]');
      expect(html).toContain('Aisha');
    });

    it('converts newlines to <br>', () => {
      const html = resolveEmailBody({
        customMessage: 'Line 1\nLine 2',
        reportType: 'report_card',
        studentName: 'Aisha',
        term: 'Term 2',
      });

      expect(html).toContain('Line 1<br>Line 2');
    });
  });

  // ─── getDefaultEmailBody ───────────────────────────────────────
  describe('getDefaultEmailBody', () => {
    it('returns the report card default with merge tags', () => {
      const body = getDefaultEmailBody('report_card');
      expect(body).toContain('Dear Parent/Guardian,');
      expect(body).toContain('Please find attached the report card for [Student Name] for [Term].');
    });

    it('returns the progress report default with merge tags', () => {
      const body = getDefaultEmailBody('progress_report');
      expect(body).toContain('Please find attached the progress report for [Student Name] for [Term].');
    });
  });

  // ─── Full template rendering ───────────────────────────────────
  describe('getReportCardEmailHTML', () => {
    const base = {
      term: 'Final Term',
      schoolName: 'Al Haadi Academy',
      customHeader: 'Report Card',
    };

    it('resolves the body per recipient (different names → different output)', () => {
      const body = 'Dear Parent, [Student Name]\'s report for [Term] is attached.';
      const a = getReportCardEmailHTML({ ...base, studentName: 'Aisha Khan', customMessage: body });
      const b = getReportCardEmailHTML({ ...base, studentName: 'Omar Ali', customMessage: body });

      expect(a).toContain('Aisha Khan');
      expect(a).not.toContain('Omar Ali');
      expect(b).toContain('Omar Ali');
      expect(b).not.toContain('Aisha Khan');
      // [Term] resolved in both
      expect(a).toContain('Final Term');
      expect(b).toContain('Final Term');
      // no leftover tags
      expect(a).not.toContain('[Student Name]');
    });

    it('falls back to the previous default wording when message is empty', () => {
      const html = getReportCardEmailHTML({ ...base, studentName: 'Aisha Khan', customMessage: '' });
      expect(html).toContain('Please find attached the report card for Aisha Khan for Final Term.');
      // fixed chrome preserved
      expect(html).toContain('Best regards');
      expect(html).toContain('Al Haadi Academy');
    });

    it('escapes teacher HTML in the rendered email', () => {
      const html = getReportCardEmailHTML({
        ...base,
        studentName: 'Aisha',
        customMessage: 'Hi <script>alert(1)</script>',
      });
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>alert(1)</script>');
    });
  });

  describe('getProgressReportEmailHTML', () => {
    it('renders the resolved body and keeps the school footer', () => {
      const html = getProgressReportEmailHTML({
        studentName: 'Sam',
        term: 'Term 1',
        schoolName: 'Al Haadi Academy',
        customHeader: 'Progress Report',
        customMessage: 'Update for [Student Name] in [Term].',
        schoolInfo: { name: 'Al Haadi Academy', address: '123 St', phone: '555', email: 'a@b.c' },
      });

      expect(html).toContain('Update for Sam in Term 1.');
      expect(html).toContain('Best regards');
      expect(html).toContain('123 St');
    });
  });
});
