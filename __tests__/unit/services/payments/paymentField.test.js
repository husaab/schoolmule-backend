const { normalizePaymentConfig, priceSelection, summaryAnswer, formatCents, PaymentFieldError } = require('../../../../services/payments/paymentField');

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
        { id: 'trip', label: 'Trip fee', amountCents: 2500, required: true },
        { id: 'lunch', label: 'Pizza lunch', amountCents: 600, required: false },
      ],
      allowOffline: true,
      accountingCode: '4210 Field trips',
      currency: 'cad',
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
    expect(priceSelection(config, [])).toEqual({ lines: [{ itemId: 'trip', label: 'Trip fee', amountCents: 2500 }], totalCents: 2500 });
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
    expect(priceSelection(optional, [])).toEqual({ lines: [], totalCents: 0 });
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
