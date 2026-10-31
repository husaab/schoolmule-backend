const printKit = require('../../../templates/printKit');

describe('printKit', () => {
  it('formats dates and school years the way the paper templates print them', () => {
    expect(printKit.formatLongDate('2026-11-14')).toBe('November 14, 2026');
    expect(printKit.schoolYearWording('2025-2026')).toEqual({ title: '2025 - 2026', short: '2025-26', full: '2025-2026' });
    expect(printKit.schoolYearWording(null)).toEqual({ title: '', short: '', full: '' });
  });

  it('builds the footer contact line, with a website only for a school domain', () => {
    expect(printKit.contactLine({ address: '1 Example Rd, Toronto, ON M1M 1M1', phone: '(416) 555-0100', email: 'a@school.example' }, 'color: red;'))
      .toBe('1 Example Rd, Toronto, M1M 1M1 | 416-555-0100 | <span style="color: red;">www.school.example</span>');
    expect(printKit.contactLine({ address: '', phone: '<b>', email: 'x@gmail.com' })).toBe('&lt;b&gt;');
  });

  it('prints compact contact details and a website only for a school domain', () => {
    expect(printKit.compactAddress('120 Example Rd, North York, ON M4A 1X5')).toBe('120 Example Rd, North York, M4A 1X5');
    expect(printKit.compactPhone('(416) 555-0100')).toBe('416-555-0100');
    expect(printKit.schoolWebsite('info@testacademy.example')).toBe('www.testacademy.example');
    expect(printKit.schoolWebsite('someone@gmail.com')).toBeNull();
    expect(printKit.schoolWebsite('')).toBeNull();
  });

  it('escapes HTML', () => {
    expect(printKit.escapeHtml(`<b>"Tom" & 'Jo'</b>`)).toBe('&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jo&#39;&lt;/b&gt;');
    expect(printKit.escapeHtml(null)).toBe('');
    expect(printKit.escapeHtml(0)).toBe('0');
  });
});
