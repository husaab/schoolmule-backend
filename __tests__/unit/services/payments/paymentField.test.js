const {
  normalizePaymentConfig, priceSelection, summaryAnswer, staffPaymentConfig, publicPaymentConfig, formatCents, PaymentFieldError,
} = require('../../../../services/payments/paymentField');

const item = (over = {}) => ({ id: 'trip', label: 'Trip fee', amountCents: 2500, required: true, ...over });

describe('normalizePaymentConfig', () => {
  it('keeps a tidy price list', () => {
    expect(normalizePaymentConfig({
      items: [item(), item({ id: 'lunch', label: '  Pizza <b>lunch</b> ', amountCents: 600, required: false })],
      allowOffline: 1,
      accountingCode: ' 4210 Field trips ',
      extra: 'dropped',
    })).toEqual({
      items: [
        { id: 'trip', label: 'Trip fee', amountCents: 2500, required: true, taxRateId: null },
        { id: 'lunch', label: 'Pizza lunch', amountCents: 600, required: false, taxRateId: null },
      ],
      allowOffline: true,
      accountingCode: '4210 Field trips',
      currency: 'cad',
      taxMode: 'added',
    });
  });

  it('refuses a field with no items, or not an object', () => {
    for (const raw of [null, undefined, [], 'x', {}, { items: [] }]) {
      expect(() => normalizePaymentConfig(raw)).toThrow(PaymentFieldError);
    }
  });

  it('refuses an item without a name, with a bad price, or with a repeated id', () => {
    expect(() => normalizePaymentConfig({ items: [item({ label: '  ' })] })).toThrow(/needs a name/);
    expect(() => normalizePaymentConfig({ items: [item({ amountCents: 49 })] })).toThrow(/price between \$0\.50/);
    expect(() => normalizePaymentConfig({ items: [item({ amountCents: 25.5 })] })).toThrow(/price between/);
    expect(() => normalizePaymentConfig({ items: [item({ amountCents: '2500' })] })).not.toThrow();
    expect(() => normalizePaymentConfig({ items: [item({ amountCents: 1000001 })] })).toThrow(/\$10,000\.00/);
    expect(() => normalizePaymentConfig({ items: [item(), item()] })).toThrow(/repeated id/);
    expect(() => normalizePaymentConfig({ items: [item({ id: 'has space' })] })).toThrow(/id/);
  });

  it('caps the number of items and the total', () => {
    const many = Array.from({ length: 21 }, (_, i) => item({ id: `i${i}` }));
    expect(() => normalizePaymentConfig({ items: many })).toThrow(/up to 20/);
    const big = Array.from({ length: 3 }, (_, i) => item({ id: `i${i}`, amountCents: 900000 }));
    expect(() => normalizePaymentConfig({ items: big })).toThrow(/at most \$20,000\.00/);
  });

  it('defaults to card only and no code', () => {
    const c = normalizePaymentConfig({ items: [item()] });
    expect(c.allowOffline).toBe(false);
    expect(c.accountingCode).toBeNull();
  });
});

describe('priceSelection', () => {
  const config = normalizePaymentConfig({
    items: [item(), item({ id: 'lunch', label: 'Pizza lunch', amountCents: 600, required: false }), item({ id: 'shirt', label: 'T-shirt', amountCents: 1500, required: false })],
  });

  it('always includes required items and adds the optional ones picked', () => {
    expect(priceSelection(config, [])).toEqual({
      lines: [{ itemId: 'trip', label: 'Trip fee', amountCents: 2500, taxCents: 0, taxName: null, taxRateMilli: null, taxIncluded: false }],
      subtotalCents: 2500,
      taxCents: 0,
      taxAddedCents: 0,
      totalCents: 2500,
    });
    expect(priceSelection(config, ['lunch']).totalCents).toBe(3100);
    expect(priceSelection(config, ['shirt', 'lunch', 'trip']).lines.map((l) => l.itemId)).toEqual(['trip', 'lunch', 'shirt']);
  });

  it('works from the form’s prices, whatever the browser sends', () => {
    expect(priceSelection(config, ['lunch', 'lunch']).totalCents).toBe(3100);
  });

  it('refuses an item the form doesn’t list', () => {
    expect(() => priceSelection(config, ['free-ipad'])).toThrow(/no longer on this form/);
  });

  it('can come to nothing when every item is optional', () => {
    const optional = normalizePaymentConfig({ items: [item({ required: false })] });
    expect(priceSelection(optional, [])).toEqual({ lines: [], subtotalCents: 0, taxCents: 0, taxAddedCents: 0, totalCents: 0 });
    expect(priceSelection(optional, undefined).totalCents).toBe(0);
  });
});

describe('summaryAnswer and formatCents', () => {
  it('reads well in an export', () => {
    expect(summaryAnswer({ lines: [{ label: 'Trip fee', amountCents: 2500 }, { label: 'Pizza lunch', amountCents: 600 }], totalCents: 3100 }, 'card'))
      .toBe('Trip fee $25.00, Pizza lunch $6.00 · Total $31.00 · Paying online');
    expect(summaryAnswer({ lines: [{ label: 'Trip fee', amountCents: 2500 }], totalCents: 2500 }, 'offline'))
      .toBe('Trip fee $25.00 · Total $25.00 · Paying at the office');
    expect(summaryAnswer({ lines: [], totalCents: 0 }, null)).toBe('Nothing to pay');
  });

  it('formats cents as dollars', () => {
    expect(formatCents(2397)).toBe('$23.97');
    expect(formatCents(120000)).toBe('$1,200.00');
    expect(formatCents(0)).toBe('$0.00');
  });
});

describe('tax on a payment field', () => {
  const HST = { taxRateId: '11111111-1111-4111-8111-111111111111', name: 'HST', rateMilli: 13000, archived: false };
  const OLD = { taxRateId: '22222222-2222-4222-8222-222222222222', name: 'PST', rateMilli: 8000, archived: true };
  const rates = new Map([[HST.taxRateId, HST], [OLD.taxRateId, OLD]]);
  const taxed = (over = {}) => ({
    items: [item({ taxRateId: HST.taxRateId }), item({ id: 'lunch', label: 'Pizza lunch', amountCents: 600, required: false, taxRateId: HST.taxRateId }), item({ id: 'pin', label: 'Pin', amountCents: 300, required: false })],
    ...over,
  });

  it('keeps a rate of the school on each item, and the mode', () => {
    const c = normalizePaymentConfig(taxed({ taxMode: 'included' }), { rates });
    expect(c.items.map((i) => i.taxRateId)).toEqual([HST.taxRateId, HST.taxRateId, null]);
    expect(c.taxMode).toBe('included');
    expect(normalizePaymentConfig(taxed({ taxMode: 'weird' }), { rates }).taxMode).toBe('added');
  });

  it('refuses a rate that isn’t the school’s, or a removed one the field didn’t have', () => {
    expect(() => normalizePaymentConfig({ items: [item({ taxRateId: 'not-ours' })] }, { rates })).toThrow(/Choose a tax rate from your school’s list/);
    expect(() => normalizePaymentConfig({ items: [item({ taxRateId: HST.taxRateId })] })).toThrow(/Choose a tax rate/);
    expect(() => normalizePaymentConfig({ items: [item({ taxRateId: OLD.taxRateId })] }, { rates })).toThrow(/Choose a tax rate/);
    expect(normalizePaymentConfig({ items: [item({ taxRateId: OLD.taxRateId })] }, { rates, keepArchived: [OLD.taxRateId] }).items[0].taxRateId).toBe(OLD.taxRateId);
  });

  it('limits the typed price to $10,000 and the total with tax to $20,000', () => {
    const twoBig = { items: [item({ id: 'a', amountCents: 900000, taxRateId: HST.taxRateId }), item({ id: 'b', amountCents: 900000, taxRateId: HST.taxRateId })] };
    expect(() => normalizePaymentConfig(twoBig, { rates })).toThrow(/with tax, can come to at most \$20,000\.00/);
    // Included tax is inside the prices, so the same items fit.
    expect(() => normalizePaymentConfig({ ...twoBig, taxMode: 'included' }, { rates })).not.toThrow();
    expect(() => normalizePaymentConfig({ items: [item({ amountCents: 1000001, taxRateId: HST.taxRateId })] }, { rates })).toThrow(/\$10,000\.00/);
  });

  it('prices tax added on top per line', () => {
    const c = normalizePaymentConfig(taxed(), { rates });
    const priced = priceSelection(c, ['lunch', 'pin'], rates);
    expect(priced.lines).toEqual([
      { itemId: 'trip', label: 'Trip fee', amountCents: 2500, taxCents: 325, taxName: 'HST', taxRateMilli: 13000, taxIncluded: false },
      { itemId: 'lunch', label: 'Pizza lunch', amountCents: 600, taxCents: 78, taxName: 'HST', taxRateMilli: 13000, taxIncluded: false },
      { itemId: 'pin', label: 'Pin', amountCents: 300, taxCents: 0, taxName: null, taxRateMilli: null, taxIncluded: false },
    ]);
    expect(priced).toMatchObject({ subtotalCents: 3400, taxCents: 403, taxAddedCents: 403, totalCents: 3803 });
  });

  it('prices tax included in the price: the total is the prices', () => {
    const c = normalizePaymentConfig(taxed({ taxMode: 'included' }), { rates });
    const priced = priceSelection(c, [], rates);
    expect(priced.lines[0]).toMatchObject({ amountCents: 2500, taxCents: 288, taxIncluded: true });
    expect(priced).toMatchObject({ subtotalCents: 2500, taxCents: 288, taxAddedCents: 0, totalCents: 2500 });
  });

  it('a field saved before tax, or a rate the school no longer has, prices as untaxed', () => {
    const before = { items: [{ id: 'trip', label: 'Trip fee', amountCents: 2500, required: true }], currency: 'cad' };
    expect(priceSelection(before, [], rates)).toMatchObject({ taxCents: 0, totalCents: 2500 });
    expect(priceSelection(normalizePaymentConfig(taxed(), { rates }), [], new Map())).toMatchObject({ taxCents: 0, totalCents: 2500 });
  });

  it('writes the tax into the stored answer, on one line', () => {
    const c = normalizePaymentConfig(taxed(), { rates });
    expect(summaryAnswer(priceSelection(c, [], rates), 'card')).toBe('Trip fee $25.00 + HST $3.25 = $28.25 (paying online)');
    expect(summaryAnswer(priceSelection(c, ['lunch'], rates), 'offline')).toBe('Trip fee $25.00, Pizza lunch $6.00 + HST $4.03 = $35.03 (paying at the office)');
    const inc = normalizePaymentConfig(taxed({ taxMode: 'included' }), { rates });
    expect(summaryAnswer(priceSelection(inc, [], rates), 'card')).toBe('Trip fee $25.00 = $25.00, includes $2.88 HST (paying online)');
  });

  it('staff read each item’s rate (removed ones flagged); families read it without ids or the accounting code', () => {
    const c = normalizePaymentConfig({ items: [item({ taxRateId: OLD.taxRateId }), item({ id: 'b' })], accountingCode: '4210' }, { rates, keepArchived: [OLD.taxRateId] });
    const staff = staffPaymentConfig(c, rates);
    expect(staff.items[0]).toMatchObject({ taxRateId: OLD.taxRateId, tax: { name: 'PST', rateMilli: 8000, archived: true } });
    expect(staff.items[1]).toMatchObject({ taxRateId: null, tax: null });
    expect(staff).toMatchObject({ taxMode: 'added', accountingCode: '4210' });
    const pub = publicPaymentConfig(c, rates);
    expect(pub.items[0]).toEqual({ id: 'trip', label: 'Trip fee', amountCents: 2500, required: true, tax: { name: 'PST', rateMilli: 8000 } });
    expect(pub.items[1].tax).toBeNull();
    expect(pub.accountingCode).toBeUndefined();
    expect(pub.taxMode).toBe('added');
    // Settings saved before tax existed.
    expect(staffPaymentConfig({ items: [{ id: 'a', label: 'A', amountCents: 100, required: true }] }, rates))
      .toEqual({ items: [{ id: 'a', label: 'A', amountCents: 100, required: true, taxRateId: null, tax: null }], taxMode: 'added' });
  });
});
