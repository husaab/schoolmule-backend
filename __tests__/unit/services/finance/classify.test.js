const { classifyInvoice, DEFAULT_SETTINGS } = require('../../../../services/finance/classify');
const { invoice, subsidyInvoice, salesLine } = require('../../../helpers/qboFixtures');

const settings = DEFAULT_SETTINGS;

describe('DEFAULT_SETTINGS', () => {
  it('knows the registration fee, or every September cell would look wrong', () => {
    expect(DEFAULT_SETTINGS.registrationFee).toBe(200);
  });
});

describe('classifyInvoice', () => {
  it('reads a grant subsidy invoice from its PrivateNote prefix', () => {
    expect(classifyInvoice(subsidyInvoice(), settings)).toBe('subsidy_grant');
  });

  it('reads a school-applied subsidy invoice from its PrivateNote prefix', () => {
    expect(classifyInvoice(subsidyInvoice({ school: true }), settings)).toBe('subsidy_school');
  });

  it('matches the note case-insensitively and with a curly apostrophe', () => {
    const inv = subsidyInvoice({ privateNote: 'AL-MA’ARIF SUBSIDY PORTION — grant' });
    expect(classifyInvoice(inv, settings)).toBe('subsidy_grant');
  });

  it('falls back to the "Subsidy share" line description when the note is missing', () => {
    const inv = subsidyInvoice({ privateNote: null });
    expect(classifyInvoice(inv, settings)).toBe('subsidy_grant');
    const school = subsidyInvoice({ school: true, privateNote: null });
    expect(classifyInvoice(school, settings)).toBe('subsidy_school');
  });

  it('keeps a parent invoice with a negative subsidy discount line as parent', () => {
    const inv = invoice({
      lines: [
        salesLine({ description: 'Omar Saleh - Grade 4 - Tuition September 2026', amount: 500 }),
        salesLine({ description: "Al-Ma'arif Subsidy - Omar Saleh", amount: -250, item: '19', itemName: 'Discount' }),
        salesLine({ description: 'Registration Fee 2026-2027 - Omar Saleh', amount: 200, item: '16', itemName: 'Application Fees' }),
      ],
    });
    expect(classifyInvoice(inv, settings)).toBe('parent');
  });

  it('does not treat EmailStatus NotSet alone as a subsidy marker (invoice 9456 case)', () => {
    const inv = invoice({ docNumber: '9456', emailStatus: 'NotSet', lines: [salesLine({ description: 'Jana Rida - Registration', amount: 200, item: '16' })] });
    expect(classifyInvoice(inv, settings)).toBe('parent');
  });

  it('marks an invoice with no tuition or registration line as other', () => {
    const inv = invoice({ lines: [salesLine({ description: 'Field trip', amount: 40, item: '77', itemName: 'Trips' })] });
    expect(classifyInvoice(inv, settings)).toBe('other');
  });

  it('honours per-school prefixes from settings', () => {
    const custom = { ...settings, subsidyNotePrefixes: { grant: 'Bursary portion', school: 'Internal bursary' } };
    expect(classifyInvoice(invoice({ privateNote: 'Bursary portion for Ali' }), custom)).toBe('subsidy_grant');
    expect(classifyInvoice(invoice({ privateNote: 'Internal bursary - Ali' }), custom)).toBe('subsidy_school');
  });
});
